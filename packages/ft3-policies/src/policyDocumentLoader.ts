// @effect-diagnostics nodeBuiltinImport:off - built-in templates are package resources, keyed by content hash.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { DocsService } from "@t3tools/ft3-docs/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import {
  builtinPolicyDocumentAsset,
  type PolicyDocumentKey,
  type PolicyDocumentSource,
  type PolicyRequirementId,
} from "./contracts.ts";
import { documentMissingIssue, storeUnavailableIssue, type PolicyIssue } from "./diagnostics.ts";
import { parseLeadSkillsDocumentSet, type ParsedLeadSkillsDocument } from "./leadSkills.ts";
import { parseRolesDocumentSet, type ParsedRolesDocument } from "./roleDocuments.ts";
import { parseRoutingPolicy, type RoutingPolicy, type RoutingRoleId } from "./routingPolicy.ts";

/** One document read, as the loader needs it from the store. */
export interface PolicyDocumentRead {
  readonly content: string;
  readonly sha256: string;
  readonly relPath: string;
  readonly stableId: string;
}

/** The two `DocsService` calls the loader makes; a port keeps `ft3-docs` out of this module's graph. */
export interface PolicyDocumentReadPort {
  readonly read: (input: {
    readonly ref: string;
  }) => Effect.Effect<PolicyDocumentRead, { readonly code: string; readonly message: string }>;
  readonly manifest: (input: {
    readonly folder: string;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly relPath: string }>,
    { readonly code: string; readonly message: string }
  >;
}

/** Adapts the live `DocsService` to the loader port. */
export const docsPolicyDocumentReadPort = (
  docs: DocsService["Service"],
): PolicyDocumentReadPort => ({
  read: (input) =>
    docs.read(input).pipe(
      Effect.map((read) => ({
        content: read.content,
        sha256: read.sha256,
        relPath: read.relPath,
        stableId: read.stableId,
      })),
    ),
  manifest: (input) => docs.manifest(input),
});

/** Features whose required roles, skills and documents the loaders check. */
export interface PolicyFeatureRequest {
  readonly board?: boolean;
  readonly planning?: boolean;
}

export interface LoadPolicyDocumentInput {
  readonly key: PolicyDocumentKey;
  readonly source: PolicyDocumentSource;
  readonly features?: PolicyFeatureRequest;
}

/** Reparses already-read files, such as an applied copy loaded from the database. */
export interface ParsePolicyDocumentInput extends LoadPolicyDocumentInput {
  readonly files: readonly LoadedPolicyFile[];
}

/** One raw file of a policy document, as applied copies and pending diffs need it. */
export interface LoadedPolicyFile {
  /** "" for the main document, else the manifest-relative path of a tree file. */
  readonly file: string;
  readonly content: string;
  readonly sha256: string;
  /** Store-relative path when the file lives in the store. */
  readonly relPath: string | null;
  /** Host path of an unmanaged file or a store file; null for bundled templates. */
  readonly absolutePath: string | null;
  readonly stableId: string | null;
}

interface LoadedPolicyDocumentBase {
  readonly source: PolicyDocumentSource;
  /** SHA-256 of the main file; null when it could not be read. */
  readonly sha256: string | null;
  readonly revision: number | null;
  readonly configured: boolean;
  /** No error-severity issue: this version may become the applied one. */
  readonly valid: boolean;
  readonly issues: readonly PolicyIssue[];
  readonly requirements: Readonly<Partial<Record<PolicyRequirementId, boolean>>>;
  /** Every file of the document, the main one keyed ""; empty when it could not be read. */
  readonly files: readonly LoadedPolicyFile[];
}

export interface LoadedRoutingPolicyDocument extends LoadedPolicyDocumentBase {
  readonly key: "routingPolicy";
  readonly document: RoutingPolicy | null;
}

export interface LoadedRolesDocument extends LoadedPolicyDocumentBase {
  readonly key: "roles";
  readonly document: ParsedRolesDocument | null;
}

export interface LoadedLeadSkillsDocument extends LoadedPolicyDocumentBase {
  readonly key: "leadSkills";
  readonly document: ParsedLeadSkillsDocument | null;
}

export type LoadedPolicyDocument =
  | LoadedRoutingPolicyDocument
  | LoadedRolesDocument
  | LoadedLeadSkillsDocument;

interface LoadedContent {
  readonly content: string;
  /** Manifest-relative `.md` files of a tree document. */
  readonly files: ReadonlyMap<string, string>;
  readonly sha256: string;
  /** Store-relative path or package asset path, for diagnostics. */
  readonly label: string;
  /** Raw files for applied copies and pending diffs. */
  readonly liveFiles: readonly LoadedPolicyFile[];
}

type ContentRead =
  | { readonly ok: true; readonly content: LoadedContent }
  | { readonly ok: false; readonly issues: readonly PolicyIssue[] };

const PACKAGE_ROOT = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const sha256Hex = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

const toPosix = (value: string): string => value.split(NodePath.sep).join("/");

const isTreeKey = (key: PolicyDocumentKey): boolean => key !== "routingPolicy";

const assetPathOf = (key: PolicyDocumentKey): string => builtinPolicyDocumentAsset(key);

const sourceLabel = (key: PolicyDocumentKey, source: PolicyDocumentSource): string => {
  switch (source.kind) {
    case "builtin":
      return assetPathOf(key);
    case "path":
      return source.path;
    case "doc":
      return source.address.kind === "path" ? source.address.relPath : source.address.stableId;
  }
};

const storeRefOf = (source: PolicyDocumentSource): string => {
  if (source.kind !== "doc") throw new Error("not a store document");
  return source.address.kind === "path"
    ? source.address.relPath
    : `oc://doc/${source.address.stableId}`;
};

const storeReadIssues = (
  key: PolicyDocumentKey,
  source: PolicyDocumentSource,
  reason: string,
  missing: boolean,
): readonly PolicyIssue[] =>
  missing
    ? [documentMissingIssue(key, sourceLabel(key, source))]
    : [storeUnavailableIssue(key, sourceLabel(key, source), reason)];

/** Files of a tree document below `directory`, keyed by `/`-separated relative path. */
const readDirectoryFiles = (directory: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  const walk = (absolute: string, prefix: string): void => {
    for (const entry of NodeFS.readdirSync(absolute, { withFileTypes: true })) {
      const child = NodePath.join(absolute, entry.name);
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(child, relative);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.set(relative, NodeFS.readFileSync(child, "utf8"));
      }
    }
  };
  walk(directory, "");
  return files;
};

const liveFilesOf = (
  main: { readonly content: string; readonly sha256: string; readonly absolutePath: string | null },
  files: ReadonlyMap<string, string>,
): readonly LoadedPolicyFile[] => [
  {
    file: "",
    content: main.content,
    sha256: main.sha256,
    relPath: null,
    absolutePath: main.absolutePath,
    stableId: null,
  },
  ...[...files.entries()].map(([file, content]) => ({
    file,
    content,
    sha256: sha256Hex(content),
    relPath: null,
    absolutePath:
      main.absolutePath === null
        ? null
        : NodePath.join(NodePath.dirname(main.absolutePath), ...file.split("/")),
    stableId: null,
  })),
];

const readBuiltin = (key: PolicyDocumentKey): ContentRead => {
  const relative = assetPathOf(key);
  const absolute = NodePath.join(PACKAGE_ROOT, ...relative.split("/"));
  try {
    const content = NodeFS.readFileSync(absolute, "utf8");
    const files: Map<string, string> = isTreeKey(key)
      ? new Map(readDirectoryFiles(NodePath.dirname(absolute)))
      : new Map();
    const manifest = NodePath.basename(absolute);
    files.delete(manifest);
    const sha256 = sha256Hex(content);
    return {
      ok: true,
      content: {
        content,
        files,
        sha256,
        label: relative,
        liveFiles: liveFilesOf({ content, sha256, absolutePath: null }, files),
      },
    };
  } catch {
    return { ok: false, issues: [documentMissingIssue(key, relative)] };
  }
};

const readServerPath = (key: PolicyDocumentKey, path: string): ContentRead => {
  try {
    const content = NodeFS.readFileSync(path, "utf8");
    const files: Map<string, string> = isTreeKey(key)
      ? new Map(readDirectoryFiles(NodePath.dirname(path)))
      : new Map();
    files.delete(NodePath.basename(path));
    const sha256 = sha256Hex(content);
    return {
      ok: true,
      content: {
        content,
        files,
        sha256,
        label: toPosix(path),
        liveFiles: liveFilesOf({ content, sha256, absolutePath: path }, files),
      },
    };
  } catch {
    return { ok: false, issues: [documentMissingIssue(key, path)] };
  }
};

const readStore = Effect.fn("PolicyDocumentLoader.readStore")(function* (
  port: PolicyDocumentReadPort,
  key: PolicyDocumentKey,
  source: PolicyDocumentSource,
) {
  const ref = storeRefOf(source);
  const read = yield* Effect.result(port.read({ ref }));
  if (Result.isFailure(read)) {
    const missing =
      read.failure.code === "document_not_found" ||
      read.failure.code === "invalid_ref" ||
      read.failure.code === "document_outside_store";
    return {
      ok: false as const,
      issues: storeReadIssues(key, source, read.failure.message, missing),
    };
  }
  const files = new Map<string, string>();
  const liveFiles: LoadedPolicyFile[] = [
    {
      file: "",
      content: read.success.content,
      sha256: read.success.sha256,
      relPath: read.success.relPath,
      absolutePath: null,
      stableId: read.success.stableId,
    },
  ];
  if (isTreeKey(key)) {
    const relPath = read.success.relPath;
    const slash = relPath.lastIndexOf("/");
    const folder = slash === -1 ? "" : relPath.slice(0, slash);
    const prefix = folder.length === 0 ? "" : `${folder}/`;
    const manifest = yield* Effect.result(port.manifest({ folder }));
    if (Result.isSuccess(manifest)) {
      for (const entry of manifest.success) {
        if (entry.relPath === relPath) continue;
        const child = yield* Effect.result(port.read({ ref: entry.relPath }));
        if (Result.isFailure(child)) continue;
        const file = entry.relPath.slice(prefix.length);
        files.set(file, child.success.content);
        liveFiles.push({
          file,
          content: child.success.content,
          sha256: child.success.sha256,
          relPath: child.success.relPath,
          absolutePath: null,
          stableId: child.success.stableId,
        });
      }
    }
  }
  return {
    ok: true as const,
    content: {
      content: read.success.content,
      files,
      sha256: read.success.sha256,
      label: read.success.relPath,
      liveFiles,
    },
  };
});

const loadRoutingPolicyDocument = (
  input: LoadPolicyDocumentInput,
  content: LoadedContent,
): LoadedRoutingPolicyDocument => {
  const requiredRoles: readonly RoutingRoleId[] =
    input.features?.planning === true ? ["planner"] : [];
  const parsed = parseRoutingPolicy(content.content, { requiredRoles });
  const document = parsed.policy;
  return {
    key: "routingPolicy",
    source: input.source,
    sha256: content.sha256,
    revision: parsed.revision,
    configured: document !== null,
    valid: document !== null,
    issues: parsed.issues,
    requirements: {
      routingPolicy: document !== null,
      requestedRoles: document !== null,
    },
    document,
    files: content.liveFiles,
  };
};

const loadRolesDocument = (
  input: LoadPolicyDocumentInput,
  content: LoadedContent,
): LoadedRolesDocument => {
  const parsed = parseRolesDocumentSet({
    manifest: content.content,
    files: content.files,
    features: {
      board: input.features?.board === true,
      planning: input.features?.planning === true,
    },
  });
  return {
    key: "roles",
    source: input.source,
    sha256: content.sha256,
    revision: parsed.revision,
    configured: parsed.configured,
    valid: parsed.valid,
    issues: parsed.issues,
    requirements: parsed.requirements,
    document: parsed.valid ? parsed : null,
    files: content.liveFiles,
  };
};

const loadLeadSkillsDocument = (
  input: LoadPolicyDocumentInput,
  content: LoadedContent,
): LoadedLeadSkillsDocument => {
  const parsed = parseLeadSkillsDocumentSet({
    manifest: content.content,
    files: content.files,
    features: {
      board: input.features?.board === true,
      planning: input.features?.planning === true,
    },
  });
  return {
    key: "leadSkills",
    source: input.source,
    sha256: content.sha256,
    revision: parsed.revision,
    configured: parsed.configured,
    valid: parsed.valid,
    issues: parsed.issues,
    requirements: parsed.requirements,
    document: parsed.valid ? parsed : null,
    files: content.liveFiles,
  };
};

const unreadDocumentIssues = (
  key: PolicyDocumentKey,
  source: PolicyDocumentSource,
  issues: readonly PolicyIssue[],
): LoadedPolicyDocument => {
  const base = {
    source,
    sha256: null,
    revision: null,
    configured: false,
    valid: false,
    issues,
    requirements: {},
    files: [],
  };
  switch (key) {
    case "routingPolicy":
      return { ...base, key, document: null };
    case "roles":
      return { ...base, key, document: null };
    case "leadSkills":
      return { ...base, key, document: null };
  }
};

const parseContent = (
  input: LoadPolicyDocumentInput,
  content: LoadedContent,
): LoadedPolicyDocument => {
  switch (input.key) {
    case "routingPolicy":
      return loadRoutingPolicyDocument(input, content);
    case "roles":
      return loadRolesDocument(input, content);
    case "leadSkills":
      return loadLeadSkillsDocument(input, content);
  }
};

const make = Effect.fn("PolicyDocumentLoader.make")(function* (port: PolicyDocumentReadPort) {
  yield* Effect.void;
  const loadSource = (input: LoadPolicyDocumentInput): Effect.Effect<ContentRead> => {
    const source = input.source;
    switch (source.kind) {
      case "builtin":
        return Effect.sync(() => readBuiltin(input.key));
      case "path":
        return Effect.sync(() => readServerPath(input.key, source.path));
      case "doc":
        return readStore(port, input.key, source);
    }
  };

  const load = Effect.fn("PolicyDocumentLoader.load")(function* (input: LoadPolicyDocumentInput) {
    const content = yield* loadSource(input);
    if (!content.ok) {
      return unreadDocumentIssues(input.key, input.source, content.issues);
    }
    return parseContent(input, content.content);
  });

  const parse = Effect.fn("PolicyDocumentLoader.parse")(function* (
    input: ParsePolicyDocumentInput,
  ) {
    yield* Effect.void;
    const main = input.files.find((file) => file.file === "");
    if (main === undefined) {
      return unreadDocumentIssues(input.key, input.source, [
        documentMissingIssue(input.key, sourceLabel(input.key, input.source)),
      ]);
    }
    const files = new Map(
      input.files.filter((file) => file.file !== "").map((file) => [file.file, file.content]),
    );
    return parseContent(input, {
      content: main.content,
      files,
      sha256: main.sha256,
      label: sourceLabel(input.key, input.source),
      liveFiles: input.files,
    });
  });

  return PolicyDocumentLoader.of({ load, parse });
});

/**
 * Loads one policy document through the read port (backed by `DocsService`), or
 * from the bundled template or an unmanaged server file, and parses it with the
 * strict parser of its key.
 */
export class PolicyDocumentLoader extends Context.Service<
  PolicyDocumentLoader,
  {
    readonly load: (
      input: LoadPolicyDocumentInput,
    ) => Effect.Effect<LoadedPolicyDocument, never, never>;
    readonly parse: (
      input: ParsePolicyDocumentInput,
    ) => Effect.Effect<LoadedPolicyDocument, never, never>;
  }
>()("@t3tools/ft3-policies/policyDocumentLoader") {}

export const layer = (port: PolicyDocumentReadPort): Layer.Layer<PolicyDocumentLoader> =>
  Layer.effect(PolicyDocumentLoader, make(port));
