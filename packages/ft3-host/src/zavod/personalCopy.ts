import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse, stringify } from "smol-toml";

import { configContents } from "./instances.ts";

export type PersonalFamily = "claude" | "codex";

type Table = Record<string, unknown>;

export type PersonalSkipReason = "secret" | "invalid" | "link";

export interface SkippedMcpServer {
  readonly name: string;
  readonly reason: "secret" | "invalid";
}

export interface FilteredMcpServers {
  readonly servers: Table;
  readonly skipped: ReadonlyArray<SkippedMcpServer>;
}

// Anything not listed here is never copied.
export const personalCopySpec = {
  claude: {
    entries: ["CLAUDE.md", "skills", "agents", "commands", "output-styles", "rules"],
    config: "settings.json",
    mcpFile: ".claude.json",
  },
  codex: {
    entries: ["AGENTS.md", "AGENTS.override.md", "skills", "prompts", "rules", "hooks.json"],
    config: "config.toml",
  },
} as const;

export function isPersonalEntry(family: PersonalFamily, name: string): boolean {
  return (personalCopySpec[family].entries as readonly string[]).includes(name);
}

const SECRET_NAME = /key|token|secret|password/i;
const SECRET_HEADER_NAME = /key|token|secret|password|auth|cookie|credential/i;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const pick = (table: Table, keep: (key: string) => boolean): Table =>
  Object.fromEntries(Object.entries(table).filter(([key]) => keep(key)));

// A `${NAME}` expansion (optionally behind an auth scheme) carries no secret itself.
function isReference(value: string): boolean {
  if (!value.includes("${")) return false;
  return (
    value
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "")
      .replace(/\b(?:Bearer|Basic|Token)\b/gi, "")
      .trim() === ""
  );
}

const isLiteralSecret = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "" && !isReference(value);

const tableHasLiteralSecret = (table: unknown, isSecretKey: (key: string) => boolean): boolean =>
  isTable(table) &&
  Object.entries(table).some(([key, value]) => isSecretKey(key) && isLiteralSecret(value));

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlCarriesSecret(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isLiteralSecret(safeDecode(parsed.username))) return true;
  if (isLiteralSecret(safeDecode(parsed.password))) return true;
  return [...parsed.searchParams].some(
    ([key, value]) => SECRET_HEADER_NAME.test(key) && isLiteralSecret(value),
  );
}

const claudeServerHasSecret = (server: Table): boolean =>
  tableHasLiteralSecret(server.env, isSecretName) ||
  tableHasLiteralSecret(server.headers, (key) => SECRET_HEADER_NAME.test(key)) ||
  urlCarriesSecret(server.url);

const codexServerHasSecret = (server: Table): boolean =>
  tableHasLiteralSecret(server.env, isSecretName) ||
  tableHasLiteralSecret(server.http_headers, (key) => SECRET_HEADER_NAME.test(key)) ||
  isLiteralSecret(server.bearer_token) ||
  urlCarriesSecret(server.url);

function filterServers(
  servers: unknown,
  hasSecret: (server: Table) => boolean,
): FilteredMcpServers {
  if (!isTable(servers)) return { servers: {}, skipped: [] };
  const kept: Table = {};
  const skipped: SkippedMcpServer[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!isTable(server)) skipped.push({ name, reason: "invalid" });
    else if (hasSecret(server)) skipped.push({ name, reason: "secret" });
    else kept[name] = server;
  }
  return { servers: kept, skipped };
}

/** Filters the `mcpServers` table of a Claude `.claude.json`. */
export const filterClaudeMcpServers = (servers: unknown): FilteredMcpServers =>
  filterServers(servers, claudeServerHasSecret);

const CLAUDE_SETTINGS_DROPPED = new Set([
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
  "model",
  "availableModels",
]);
const CLAUDE_ENV_ROUTE =
  /^(?:ANTHROPIC_|AWS_|CLAUDE_CODE_USE_)|^CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY$/i;

/** Drops the route, credential helpers and secret env from a personal Claude `settings.json`. */
export function filterClaudeSettings(settings: Table): Table {
  const result = pick(settings, (key) => key !== "env" && !CLAUDE_SETTINGS_DROPPED.has(key));
  if (isTable(settings.env)) {
    const env = pick(settings.env, (key) => !CLAUDE_ENV_ROUTE.test(key) && !isSecretName(key));
    if (Object.keys(env).length > 0) result.env = env;
  }
  return result;
}

const CODEX_CONFIG_DROPPED = new Set([
  "model_provider",
  "model_providers",
  "model",
  "model_catalog_json",
  "openai_base_url",
  "chatgpt_base_url",
  "otel",
  "profiles",
  "shell_environment_policy",
  "mcp_servers",
]);

/** Drops the route, secret env and secret MCP servers from a personal Codex `config.toml`. */
export function filterCodexConfig(config: Table): {
  readonly config: Table;
  readonly skipped: ReadonlyArray<SkippedMcpServer>;
} {
  const result = pick(config, (key) => !CODEX_CONFIG_DROPPED.has(key));
  if (isTable(config.profiles)) {
    result.profiles = Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [
        name,
        isTable(profile)
          ? pick(profile, (key) => key !== "model_provider" && key !== "model")
          : profile,
      ]),
    );
  }
  if (isTable(config.shell_environment_policy)) {
    const { set, ...policy } = config.shell_environment_policy;
    const safeSet = isTable(set) ? pick(set, (key) => !isSecretName(key)) : undefined;
    result.shell_environment_policy =
      safeSet === undefined || Object.keys(safeSet).length === 0
        ? policy
        : { ...policy, set: safeSet };
  }
  const { servers, skipped } = filterServers(config.mcp_servers, codexServerHasSecret);
  if (Object.keys(servers).length > 0) result.mcp_servers = servers;
  return { config: result, skipped };
}

// Personal wins at the top level and, for the named tables, per key.
function mergeTables(existing: Table, personal: Table, nested: readonly string[]): Table {
  const result = { ...existing, ...personal };
  for (const key of nested) {
    const before = existing[key];
    const after = personal[key];
    if (isTable(before) && isTable(after)) result[key] = { ...before, ...after };
  }
  return result;
}

export const mergeClaudeSettings = (existing: Table, personal: Table): Table =>
  mergeTables(existing, personal, ["env"]);

export const mergeClaudeMcpServers = (existingClaudeJson: Table, servers: Table): Table =>
  Object.keys(servers).length === 0
    ? existingClaudeJson
    : mergeTables(existingClaudeJson, { mcpServers: servers }, ["mcpServers"]);

export const mergeCodexConfig = (existing: Table, personal: Table): Table =>
  mergeTables(existing, personal, ["mcp_servers"]);

export class ZavodPersonalCopyError extends Schema.TaggedError<
  ZavodPersonalCopyError,
  { readonly brand: unique symbol }
>()("ZavodPersonalCopyError", {
  stage: Schema.Literals(["state", "limit", "copy"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Zavod personal copy ${this.stage} failed.`;
  }
}

export interface PersonalCopyItem {
  readonly family: PersonalFamily;
  readonly path: string;
  readonly action: "create" | "overwrite" | "merge";
}

export interface PersonalCopySkipped {
  readonly family: PersonalFamily;
  readonly path: string;
  readonly reason: PersonalSkipReason;
}

export interface PersonalCopyReport {
  readonly items: ReadonlyArray<PersonalCopyItem>;
  readonly skipped: ReadonlyArray<PersonalCopySkipped>;
}

export interface PersonalCopySource {
  readonly family: PersonalFamily;
  readonly sourceHome: string;
  readonly targetHome: string;
  /** Claude only: the file that holds the user-scope `mcpServers`. */
  readonly claudeJson?: string;
}

export interface PersonalCopyLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export const PERSONAL_COPY_LIMITS: PersonalCopyLimits = {
  maxFiles: 5000,
  maxBytes: 64 * 1024 * 1024,
};

const isCopyError = Schema.is(ZavodPersonalCopyError);
const decodeJsonTable = Schema.decodeUnknownSync(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

const parseJsonTable = (text: string): Table | undefined => {
  try {
    return decodeJsonTable(text);
  } catch {
    return undefined;
  }
};

const parseTomlTable = (text: string): Table | undefined => {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
};

// The Zavod route is laid over the merged text again, so a personal route can never win.
const claudeSettingsContents = (
  existingText: string | undefined,
  personal: Table,
  baseUrl: string,
  helperPath: string,
  windows: boolean,
): string =>
  configContents(
    JSON.stringify(
      mergeClaudeSettings(
        existingText === undefined ? {} : decodeJsonTable(existingText),
        filterClaudeSettings(personal),
      ),
    ),
    true,
    baseUrl,
    helperPath,
    windows,
  );

const claudeJsonContents = (existingText: string | undefined, servers: Table): string =>
  `${JSON.stringify(
    mergeClaudeMcpServers(existingText === undefined ? {} : decodeJsonTable(existingText), servers),
    null,
    2,
  )}\n`;

const codexConfigContents = (
  existingText: string | undefined,
  filtered: Table,
  baseUrl: string,
  helperPath: string,
  windows: boolean,
): string =>
  configContents(
    stringify(mergeCodexConfig(existingText === undefined ? {} : parse(existingText), filtered)),
    false,
    baseUrl,
    helperPath,
    windows,
  );

type Probe =
  | { readonly kind: "missing" | "broken" | "other" | "dir" }
  | { readonly kind: "file"; readonly size: number; readonly mode: number };

interface TreeEntry {
  readonly sub: string;
  readonly source: string;
  readonly type: "File" | "Directory";
  readonly mode: number;
}

interface CopyUnit {
  readonly rel: string;
  readonly source: string;
  readonly target: string;
  readonly type: "File" | "Directory";
  readonly mode: number;
  readonly tree: ReadonlyArray<TreeEntry>;
}

interface ConfigWrite {
  readonly rel: string;
  readonly target: string;
  readonly contents: string;
}

interface FamilyPlan {
  readonly targetHome: string;
  readonly units: Array<CopyUnit>;
  readonly writes: Array<ConfigWrite>;
}

interface PersonalCopyPlan extends PersonalCopyReport {
  readonly families: ReadonlyArray<FamilyPlan>;
}

const MAX_LINK_HOPS = 40;

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const buildPlan = Effect.fn("ZavodPersonalCopy.plan")(function* (input: {
  readonly families: ReadonlyArray<PersonalCopySource>;
  readonly baseUrl: string;
  readonly helperPath: string;
  readonly limits: PersonalCopyLimits;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = path.sep === "\\";
  const budget = { files: 0, bytes: 0 };
  const items: Array<PersonalCopyItem> = [];
  const skipped: Array<PersonalCopySkipped> = [];
  const familyPlans: Array<FamilyPlan> = [];

  const normalize = (value: string) => (windows ? value.toLowerCase() : value);
  const contains = (outer: string, inner: string) => {
    const base = normalize(outer);
    const target = normalize(inner);
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  };
  const probe = (file: string): Effect.Effect<Probe, PlatformError.PlatformError> =>
    fs.stat(file).pipe(
      Effect.map((info): Probe =>
        info.type === "File"
          ? { kind: "file", size: Number(info.size), mode: info.mode & 0o777 }
          : info.type === "Directory"
            ? { kind: "dir" }
            : { kind: "other" },
      ),
      Effect.catch(() =>
        fs.lstat(file).pipe(
          Effect.map((): Probe => ({ kind: "broken" })),
          Effect.catchIf(isNotFound, () => Effect.succeed<Probe>({ kind: "missing" })),
        ),
      ),
    );
  const exists = (file: string) =>
    fs.lstat(file).pipe(
      Effect.as(true),
      Effect.catchIf(isNotFound, () => Effect.succeed(false)),
    );
  const readText = (file: string) =>
    fs.readFileString(file).pipe(Effect.catchIf(isNotFound, () => Effect.undefined));
  const count = (size: number) => {
    budget.files += 1;
    budget.bytes += size;
    return budget.files > input.limits.maxFiles || budget.bytes > input.limits.maxBytes
      ? Effect.fail(new ZavodPersonalCopyError({ stage: "limit" }))
      : Effect.void;
  };

  for (const source of input.families) {
    const { family } = source;
    const spec = personalCopySpec[family];
    const sourceReal = yield* fs
      .realPath(source.sourceHome)
      .pipe(Effect.catchIf(isNotFound, () => Effect.undefined));
    if (sourceReal === undefined) continue;
    const targetReal = yield* fs
      .realPath(source.targetHome)
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(source.targetHome)));
    if (normalize(sourceReal) === normalize(targetReal)) {
      return yield* new ZavodPersonalCopyError({ stage: "state" });
    }
    const plan: FamilyPlan = { targetHome: source.targetHome, units: [], writes: [] };
    familyPlans.push(plan);

    const skip = (rel: string, reason: PersonalSkipReason) => {
      skipped.push({ family, path: rel, reason });
    };
    const usable = (rel: string, found: Probe) => {
      if (found.kind === "broken") skip(rel, "link");
      else if (found.kind === "other") skip(rel, "invalid");
      return found.kind === "file" || found.kind === "dir";
    };
    // A link back to an ancestor, or to the home itself, would pull in credentials and history.
    const descend = Effect.fn("ZavodPersonalCopy.descend")(function* (
      dir: string,
      rel: string,
      ancestors: ReadonlySet<string>,
    ) {
      const real = yield* fs.realPath(dir);
      if (ancestors.has(real) || contains(real, sourceReal)) {
        skip(rel, "link");
        return undefined;
      }
      return new Set(ancestors).add(real);
    });
    const walk = Effect.fn("ZavodPersonalCopy.walk")(function* (
      dir: string,
      rel: string,
      sub: string,
      ancestors: ReadonlySet<string>,
      tree: Array<TreeEntry>,
    ): Effect.fn.Return<
      void,
      ZavodPersonalCopyError | PlatformError.PlatformError,
      FileSystem.FileSystem | Path.Path
    > {
      for (const name of (yield* fs.readDirectory(dir)).toSorted()) {
        const child = path.join(dir, name);
        const childRel = `${rel}/${name}`;
        const childSub = sub === "" ? name : `${sub}/${name}`;
        const found = yield* probe(child);
        if (found.kind === "missing" || !usable(childRel, found)) continue;
        if (found.kind === "file") {
          yield* count(found.size);
          tree.push({ sub: childSub, source: child, type: "File", mode: found.mode });
          continue;
        }
        const next = yield* descend(child, childRel, ancestors);
        if (next === undefined) continue;
        tree.push({ sub: childSub, source: child, type: "Directory", mode: 0o755 });
        yield* walk(child, childRel, childSub, next, tree);
      }
    });
    const planUnit = Effect.fn("ZavodPersonalCopy.planUnit")(function* (
      rel: string,
      file: string,
      ancestors: ReadonlySet<string>,
    ) {
      const found = yield* probe(file);
      if (found.kind === "missing" || !usable(rel, found)) return;
      const target = path.join(source.targetHome, ...rel.split("/"));
      const action = (yield* exists(target)) ? "overwrite" : "create";
      if (found.kind === "file") {
        yield* count(found.size);
        plan.units.push({ rel, source: file, target, type: "File", mode: found.mode, tree: [] });
      } else {
        const next = yield* descend(file, rel, ancestors);
        if (next === undefined) return;
        const tree: Array<TreeEntry> = [];
        yield* walk(file, rel, "", next, tree);
        plan.units.push({ rel, source: file, target, type: "Directory", mode: 0o755, tree });
      }
      items.push({ family, path: rel, action });
    });

    for (const name of spec.entries) {
      const entry = path.join(source.sourceHome, name);
      const found = yield* probe(entry);
      if (found.kind === "missing" || !usable(name, found)) continue;
      if (found.kind === "file") {
        yield* planUnit(name, entry, new Set());
        continue;
      }
      const next = yield* descend(entry, name, new Set());
      if (next === undefined) continue;
      for (const child of (yield* fs.readDirectory(entry)).toSorted()) {
        yield* planUnit(`${name}/${child}`, path.join(entry, child), next);
      }
    }

    const guarded = <A>(compute: () => A) =>
      Effect.try({
        try: compute,
        catch: (cause) => new ZavodPersonalCopyError({ stage: "copy", cause }),
      });
    // A merged config is written like any copied file, so it spends the same budget.
    const addWrite = Effect.fn("ZavodPersonalCopy.addWrite")(function* (
      rel: string,
      contents: string,
      existed: boolean,
    ) {
      yield* count(new TextEncoder().encode(contents).length);
      plan.writes.push({ rel, target: path.join(source.targetHome, rel), contents });
      items.push({ family, path: rel, action: existed ? "merge" : "create" });
    });

    if (family === "claude") {
      const claude = personalCopySpec.claude;
      const personalText = yield* readText(path.join(source.sourceHome, claude.config));
      const personal = personalText === undefined ? undefined : parseJsonTable(personalText);
      if (personalText !== undefined && personal === undefined) skip(claude.config, "invalid");
      if (personal !== undefined) {
        const existingText = yield* readText(path.join(source.targetHome, claude.config));
        const contents = yield* guarded(() =>
          claudeSettingsContents(existingText, personal, input.baseUrl, input.helperPath, windows),
        );
        yield* addWrite(claude.config, contents, existingText !== undefined);
      }
      const jsonText =
        source.claudeJson === undefined ? undefined : yield* readText(source.claudeJson);
      const json = jsonText === undefined ? undefined : parseJsonTable(jsonText);
      if (jsonText !== undefined && json === undefined) skip(claude.mcpFile, "invalid");
      if (json !== undefined) {
        const filtered = filterClaudeMcpServers(json.mcpServers);
        for (const server of filtered.skipped) {
          skip(`${claude.mcpFile}:mcpServers.${server.name}`, server.reason);
        }
        if (Object.keys(filtered.servers).length > 0) {
          const existingText = yield* readText(path.join(source.targetHome, claude.mcpFile));
          const contents = yield* guarded(() => claudeJsonContents(existingText, filtered.servers));
          yield* addWrite(claude.mcpFile, contents, existingText !== undefined);
        }
      }
    } else {
      const codex = personalCopySpec.codex;
      const personalText = yield* readText(path.join(source.sourceHome, codex.config));
      const personal = personalText === undefined ? undefined : parseTomlTable(personalText);
      if (personalText !== undefined && personal === undefined) skip(codex.config, "invalid");
      if (personal !== undefined) {
        const filtered = filterCodexConfig(personal);
        for (const server of filtered.skipped) {
          skip(`${codex.config}:mcp_servers.${server.name}`, server.reason);
        }
        const existingText = yield* readText(path.join(source.targetHome, codex.config));
        const contents = yield* guarded(() =>
          codexConfigContents(
            existingText,
            filtered.config,
            input.baseUrl,
            input.helperPath,
            windows,
          ),
        );
        yield* addWrite(codex.config, contents, existingText !== undefined);
      }
    }
  }
  return { items, skipped, families: familyPlans } satisfies PersonalCopyPlan;
});

const applyPlan = Effect.fn("ZavodPersonalCopy.apply")(function* (plan: PersonalCopyPlan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = path.sep === "\\";
  const normalize = (value: string) => (windows ? value.toLowerCase() : value);
  const inside = (root: string, file: string) => {
    const base = normalize(root);
    const target = normalize(file);
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  };

  // The atomic write follows links, so the check has to end where the write ends: a missing
  // leaf resolves through its nearest existing parent.
  const resolveWriteTarget = Effect.fn("ZavodPersonalCopy.resolveWriteTarget")(function* (
    file: string,
    hops = 0,
  ): Effect.fn.Return<string, ZavodPersonalCopyError | PlatformError.PlatformError> {
    if (hops > MAX_LINK_HOPS) return yield* new ZavodPersonalCopyError({ stage: "copy" });
    const info = yield* fs.lstat(file).pipe(Effect.catchIf(isNotFound, () => Effect.undefined));
    if (info === undefined) {
      const parent = path.dirname(file);
      if (parent === file) return file;
      return path.join(yield* resolveWriteTarget(parent, hops), path.basename(file));
    }
    if (info.type === "SymbolicLink") {
      const link = yield* fs.readLink(file);
      return yield* resolveWriteTarget(path.resolve(path.dirname(file), link), hops + 1);
    }
    return yield* fs.realPath(file);
  });

  for (const family of plan.families) {
    if (family.units.length === 0 && family.writes.length === 0) continue;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(family.targetHome, { recursive: true });
        const root = yield* fs.realPath(family.targetHome);
        const guard = Effect.fn("ZavodPersonalCopy.guard")(function* (real: string) {
          if (!inside(root, real)) return yield* new ZavodPersonalCopyError({ stage: "copy" });
        });
        // Staging sits in the Zavod home, outside the copied folders, so a crash leaves no phantom skill.
        const staging = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ directory: family.targetHome, prefix: ".zavod-copy-" }),
          (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
        );
        const copyFile = (from: string, to: string, mode: number) =>
          fs
            .readFile(from)
            .pipe(
              Effect.flatMap((bytes) => fs.writeFile(to, bytes, windows ? undefined : { mode })),
            );

        for (const [index, unit] of family.units.entries()) {
          const parent = path.dirname(unit.target);
          yield* fs.makeDirectory(parent, { recursive: true });
          yield* guard(yield* fs.realPath(parent));
          const stage = path.join(staging, String(index));
          if (unit.type === "File") {
            yield* copyFile(unit.source, stage, unit.mode);
          } else {
            yield* fs.makeDirectory(stage);
            for (const entry of unit.tree) {
              const to = path.join(stage, ...entry.sub.split("/"));
              if (entry.type === "Directory") yield* fs.makeDirectory(to);
              else yield* copyFile(entry.source, to, entry.mode);
            }
          }
          const current = yield* fs
            .lstat(unit.target)
            .pipe(Effect.catchIf(isNotFound, () => Effect.undefined));
          if (current === undefined || (unit.type === "File" && current.type === "File")) {
            yield* fs.rename(stage, unit.target);
            continue;
          }
          const old = path.join(staging, `${index}.old`);
          yield* fs.rename(unit.target, old);
          yield* fs
            .rename(stage, unit.target)
            .pipe(Effect.tapError(() => fs.rename(old, unit.target).pipe(Effect.ignore)));
          yield* fs.remove(old, { recursive: true, force: true });
        }

        for (const write of family.writes) {
          yield* guard(yield* resolveWriteTarget(write.target));
          yield* writeFileStringAtomically({ filePath: write.target, contents: write.contents });
        }
      }),
    );
  }
});

/** Copies allowlisted personal settings into the Zavod homes; a dry run only reports the plan. */
export const copyPersonalSettings = Effect.fn("ZavodPersonalCopy.copy")(
  function* (input: {
    readonly families: ReadonlyArray<PersonalCopySource>;
    readonly baseUrl: string;
    readonly helperPath: string;
    readonly dryRun: boolean;
    readonly limits?: PersonalCopyLimits;
  }) {
    const plan = yield* buildPlan({ ...input, limits: input.limits ?? PERSONAL_COPY_LIMITS });
    if (!input.dryRun) yield* applyPlan(plan);
    return { items: plan.items, skipped: plan.skipped } satisfies PersonalCopyReport;
  },
  (effect) =>
    Effect.mapError(effect, (cause) =>
      isCopyError(cause) ? cause : new ZavodPersonalCopyError({ stage: "copy", cause }),
    ),
);
