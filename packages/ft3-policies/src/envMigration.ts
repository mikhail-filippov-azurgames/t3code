// @effect-diagnostics nodeBuiltinImport:off - a legacy env value may be an absolute file path.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DocsService, DocsPathLocation } from "@t3tools/ft3-docs/server";
import { parseDocRef } from "@t3tools/ft3-docs/contracts";
import * as Effect from "effect/Effect";

import type { PolicyDocumentSource } from "./contracts.ts";
import { legacyPolicyRefUnresolvedIssue, type PolicyIssue } from "./diagnostics.ts";
import {
  POLICY_ENV_MIGRATION_VERSION,
  type PoliciesSettings,
  type PolicyDocumentsSettings,
} from "./settings.ts";

/** Legacy settings of the live server; read once, then ignored (design §12.1). */
export const ROLES_DIR_ENV = "T3CODE_FT3_ROLES_DIR";
export const ROUTING_POLICY_REF_ENV = "T3CODE_FT3_ROUTING_POLICY_REF";

/** The two `DocsService` calls the migration makes, as a port for tests. */
export interface PolicyEnvDocsPort {
  readonly locateServerPath: (
    absolutePath: string,
  ) => Effect.Effect<DocsPathLocation | null, never>;
  readonly docRef: (ref: string) => Effect.Effect<{ readonly stableId: string } | null, never>;
}

export const docsPolicyEnvPort = (docs: DocsService["Service"]): PolicyEnvDocsPort => ({
  locateServerPath: (absolutePath) =>
    docs.locateServerPath(absolutePath).pipe(Effect.orElseSucceed(() => null)),
  docRef: (ref) =>
    docs.docRef(ref).pipe(
      Effect.map((resolved) => ({ stableId: resolved.stableId })),
      Effect.orElseSucceed(() => null),
    ),
});

export interface PolicyEnvMigrationInput {
  readonly settings: PoliciesSettings;
  readonly docs: PolicyEnvDocsPort;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface PolicyEnvMigrationResult {
  readonly settings: PoliciesSettings;
  /** The caller must persist the settings when true. */
  readonly changed: boolean;
  readonly warnings: readonly PolicyIssue[];
}

const trimmed = (value: string | undefined): string => value?.trim() ?? "";

/** A store document by stable id, else a store path, else an unmanaged server file. */
const sourceForServerPath = Effect.fn("PolicyEnvMigration.sourceForServerPath")(function* (
  docs: PolicyEnvDocsPort,
  absolutePath: string,
) {
  const resolved = NodePath.resolve(absolutePath);
  const location = yield* docs.locateServerPath(resolved);
  if (location === null) {
    return { kind: "path", path: resolved } satisfies PolicyDocumentSource;
  }
  if (location.stableId !== null) {
    return {
      kind: "doc",
      address: { kind: "id", stableId: location.stableId },
    } satisfies PolicyDocumentSource;
  }
  return {
    kind: "doc",
    address: { kind: "path", relPath: location.relPath },
  } satisfies PolicyDocumentSource;
});

const sourceForRoutingRef = Effect.fn("PolicyEnvMigration.sourceForRoutingRef")(function* (
  docs: PolicyEnvDocsPort,
  ref: string,
) {
  const address = parseDocRef(ref);
  if (address?.kind === "id") {
    const resolved = yield* docs.docRef(ref);
    return resolved !== null
      ? ({
          source: {
            kind: "doc",
            address: { kind: "id", stableId: resolved.stableId },
          } satisfies PolicyDocumentSource,
        } as const)
      : ({ unresolved: "not found in the document store" } as const);
  }
  return { source: yield* sourceForServerPath(docs, ref) } as const;
});

/**
 * Folds `T3CODE_FT3_ROLES_DIR` and `T3CODE_FT3_ROUTING_POLICY_REF` into the
 * settings document sources once. Explicit settings win per document; the
 * marker makes later starts ignore both variables.
 */
export const migratePolicyEnvironment = Effect.fn("PolicyEnvMigration.run")(function* (
  input: PolicyEnvMigrationInput,
) {
  if (input.settings.envMigration === POLICY_ENV_MIGRATION_VERSION) {
    return {
      settings: input.settings,
      changed: false,
      warnings: [],
    } satisfies PolicyEnvMigrationResult;
  }

  const environment = input.environment ?? {};
  const rolesDir = trimmed(environment[ROLES_DIR_ENV]);
  const routingRef = trimmed(environment[ROUTING_POLICY_REF_ENV]);
  const warnings: PolicyIssue[] = [];
  const documents: {
    -readonly [K in keyof PolicyDocumentsSettings]: PolicyDocumentsSettings[K];
  } = { ...input.settings.documents };

  if (rolesDir !== "" && documents.roles.kind === "builtin") {
    const manifest = NodePath.join(rolesDir, "roles.json");
    if (NodeFS.existsSync(manifest)) {
      documents.roles = yield* sourceForServerPath(input.docs, manifest);
    }
    const skills = NodePath.join(rolesDir, "skills", "lead", "lead-skills.json");
    if (documents.leadSkills.kind === "builtin" && NodeFS.existsSync(skills)) {
      documents.leadSkills = yield* sourceForServerPath(input.docs, skills);
    }
  }

  if (routingRef !== "" && documents.routingPolicy.kind === "builtin") {
    const resolved = yield* sourceForRoutingRef(input.docs, routingRef);
    if ("source" in resolved) {
      documents.routingPolicy = resolved.source;
    } else {
      warnings.push(legacyPolicyRefUnresolvedIssue(routingRef, resolved.unresolved));
    }
  }

  return {
    settings: {
      ...input.settings,
      documents,
      envMigration: POLICY_ENV_MIGRATION_VERSION,
    },
    changed: true,
    warnings,
  } satisfies PolicyEnvMigrationResult;
});
