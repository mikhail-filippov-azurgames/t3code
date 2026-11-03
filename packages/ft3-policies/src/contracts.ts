/**
 * Browser-safe policy contracts: the policy document keys and sources, the
 * applied-document ref, and the feature registry with its dependency graph.
 *
 * Parsers, loaders, snapshots and RPC land in later slices of the same design;
 * nothing here reads a file or touches a store.
 */
import { DocAddress, DocSha256 } from "@t3tools/ft3-docs/contracts";
import * as Schema from "effect/Schema";

/** Settings key of a policy document under `ft3.policies.documents`. */
export const POLICY_DOCUMENT_KEYS = ["routingPolicy", "roles", "leadSkills"] as const;
export type PolicyDocumentKey = (typeof POLICY_DOCUMENT_KEYS)[number];
export const PolicyDocumentKey = Schema.Literals(POLICY_DOCUMENT_KEYS);

export const POLICY_DOCUMENT_PATH_MAX_LENGTH = 4096;

const isNonBlankPath = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a non-empty server path",
});

/** An absolute server path outside the document store; the store path is never stored here. */
export const PolicyDocumentPath = Schema.String.check(
  isNonBlankPath,
  Schema.isMaxLength(POLICY_DOCUMENT_PATH_MAX_LENGTH),
);
export type PolicyDocumentPath = typeof PolicyDocumentPath.Type;

/**
 * Where a policy document comes from: a Corvis-built-in template, a document
 * in the store (addressed through `ft3-docs`), or an unmanaged server file.
 */
export const PolicyDocumentSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("builtin") }),
  Schema.Struct({ kind: Schema.Literal("doc"), address: DocAddress }),
  Schema.Struct({ kind: Schema.Literal("path"), path: PolicyDocumentPath }),
]);
export type PolicyDocumentSource = typeof PolicyDocumentSource.Type;

/** Built-in templates shipped inside this package; the settings default. */
export const BUILTIN_POLICY_DOCUMENT_ASSETS = {
  routingPolicy: "assets/routing-policy.md",
  roles: "assets/roles/roles.json",
  leadSkills: "assets/lead-skills/lead-skills.json",
} as const satisfies Readonly<Record<PolicyDocumentKey, string>>;

/** Package-relative asset of a built-in template, or null for a user-selected source. */
export function builtinPolicyDocumentAsset(key: PolicyDocumentKey): string {
  return BUILTIN_POLICY_DOCUMENT_ASSETS[key];
}

/**
 * A policy document as the snapshot reports it. `revision` and `sha256`
 * describe the applied version and stay null until one exists.
 */
export const PolicyDocumentRef = Schema.Struct({
  key: PolicyDocumentKey,
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  sha256: Schema.NullOr(DocSha256),
  source: PolicyDocumentSource,
  configured: Schema.Boolean,
  pending: Schema.Boolean,
});
export type PolicyDocumentRef = typeof PolicyDocumentRef.Type;

/**
 * Feature toggles, in the order the settings document lists them. `architect`
 * is retired: it is neither listed nor accepted, and a stored value is dropped.
 */
export const FEATURE_IDS = [
  "documents",
  "roles",
  "board",
  "mail",
  "planning",
  "delegation",
  "orchestration",
  "boardAutomation",
  "sidebarForest",
  "chatExtensions",
  "vcs",
  "pi",
  "kimi",
  "usage",
  "files",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
export const FeatureId = Schema.Literals(FEATURE_IDS);

/** A document or role that must be valid and configured for a feature to work. */
export const POLICY_REQUIREMENT_IDS = [
  "documentsStore",
  "rolesManifest",
  "leadSkills",
  "leadRole",
  "routingPolicy",
  "requestedRoles",
  "plannerRole",
  "architectRole",
  "planOrchestratorSkill",
] as const;
export type PolicyRequirementId = (typeof POLICY_REQUIREMENT_IDS)[number];
export const PolicyRequirementId = Schema.Literals(POLICY_REQUIREMENT_IDS);

export interface FeatureDefinition {
  readonly dependencies: readonly FeatureId[];
  readonly requirements: readonly PolicyRequirementId[];
}

/**
 * The feature registry. Dependency edges are the design's graph:
 * `board -> roles`, `mail -> board, delegation`,
 * `planning -> mail, documents`. The remaining toggles keep their own
 * behavior and declare no dependency in this slice.
 */
export const FEATURE_REGISTRY: Readonly<Record<FeatureId, FeatureDefinition>> = {
  documents: {
    dependencies: [],
    requirements: ["documentsStore"],
  },
  roles: {
    dependencies: [],
    requirements: ["rolesManifest"],
  },
  board: {
    dependencies: ["roles"],
    requirements: ["leadSkills", "leadRole"],
  },
  mail: {
    dependencies: ["board", "delegation"],
    requirements: ["routingPolicy", "requestedRoles"],
  },
  planning: {
    dependencies: ["mail", "documents"],
    requirements: ["plannerRole", "architectRole", "planOrchestratorSkill"],
  },
  delegation: { dependencies: [], requirements: [] },
  orchestration: { dependencies: [], requirements: [] },
  boardAutomation: { dependencies: [], requirements: [] },
  sidebarForest: { dependencies: [], requirements: [] },
  chatExtensions: { dependencies: [], requirements: [] },
  vcs: { dependencies: [], requirements: [] },
  pi: { dependencies: [], requirements: [] },
  kimi: { dependencies: [], requirements: [] },
  usage: { dependencies: [], requirements: [] },
  files: { dependencies: [], requirements: [] },
};

/** A feature is off because one of its dependencies is ineffective. */
export interface FeatureDependencyOffReason {
  readonly code: "feature_dependency_off";
  readonly dependency: FeatureId;
}

/** A feature is off because a required document or role is not valid. */
export interface FeatureDocumentOffReason {
  readonly code: "feature_document_off";
  readonly requirement: PolicyRequirementId;
}

export type FeatureOffReason = FeatureDependencyOffReason | FeatureDocumentOffReason;

export interface FeatureResolution {
  readonly id: FeatureId;
  /** What the environment (and an optional project override) asked for. */
  readonly requestedEnabled: boolean;
  /** `requestedEnabled && dependencies effective && requirements valid`. */
  readonly effectiveEnabled: boolean;
  /** Null when the feature is on, or when it was not requested at all. */
  readonly offReason: FeatureOffReason | null;
}

export interface FeatureResolutionInput {
  readonly requested: Readonly<Partial<Record<FeatureId, boolean>>>;
  /**
   * Requirement validity computed by the document loader; a missing entry is
   * unknown and does not turn a feature off.
   */
  readonly requirements?: Readonly<Partial<Record<PolicyRequirementId, boolean>>>;
}

/**
 * Resolves every feature once. Dependencies are resolved first, in the order
 * the registry declares them, so the first failing dependency is reported.
 */
export function resolveFeatureStates(
  input: FeatureResolutionInput,
): Readonly<Record<FeatureId, FeatureResolution>> {
  const states: Record<FeatureId, FeatureResolution> = {} as Record<FeatureId, FeatureResolution>;
  const resolving = new Set<FeatureId>();

  const resolveOne = (id: FeatureId): FeatureResolution => {
    const resolved = states[id];
    if (resolved !== undefined) return resolved;
    if (resolving.has(id)) throw new Error(`Feature dependency cycle at "${id}".`);
    resolving.add(id);

    const definition = FEATURE_REGISTRY[id];
    const requestedEnabled = input.requested[id] === true;
    let state: FeatureResolution | null = null;

    if (requestedEnabled) {
      const offDependency = definition.dependencies.find(
        (dependency) => !resolveOne(dependency).effectiveEnabled,
      );
      if (offDependency !== undefined) {
        state = {
          id,
          requestedEnabled,
          effectiveEnabled: false,
          offReason: { code: "feature_dependency_off", dependency: offDependency },
        };
      } else {
        const missingRequirement = definition.requirements.find(
          (requirement) => input.requirements?.[requirement] === false,
        );
        if (missingRequirement !== undefined) {
          state = {
            id,
            requestedEnabled,
            effectiveEnabled: false,
            offReason: { code: "feature_document_off", requirement: missingRequirement },
          };
        }
      }
    }

    state ??= { id, requestedEnabled, effectiveEnabled: requestedEnabled, offReason: null };
    resolving.delete(id);
    states[id] = state;
    return state;
  };

  for (const id of FEATURE_IDS) resolveOne(id);
  return states;
}
