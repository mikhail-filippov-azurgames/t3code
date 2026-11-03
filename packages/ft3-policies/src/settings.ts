/**
 * Fork-owned policy settings under `ft3.policies`: document sources, feature
 * toggles and the typed per-project `ft3PolicyDocuments` override. Upstream
 * `ServerSettings` only carries the generic `ft3` namespace; schema and defaults
 * live here. Toggles and `applyExternalEdits` are environment wide.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type FeatureId,
  PolicyDocumentKey,
  type PolicyDocumentSource,
  PolicyDocumentSource as PolicyDocumentSourceSchema,
  type PolicyRequirementId,
} from "./contracts.ts";

/** Key of the policy namespace inside `ServerSettings.ft3`. */
export const POLICY_SETTINGS_NAMESPACE = "policies";

/**
 * Toggle defaults match the design's starting point. `architect` is absent on
 * purpose; every other rev2 toggle keeps its current behavior.
 */
export const DEFAULT_FEATURE_TOGGLES: Readonly<Record<FeatureId, boolean>> = {
  documents: true,
  roles: true,
  board: true,
  mail: false,
  planning: false,
  delegation: true,
  orchestration: true,
  boardAutomation: true,
  sidebarForest: true,
  chatExtensions: true,
  vcs: true,
  pi: true,
  kimi: true,
  usage: true,
  files: true,
};

const featureToggle = (enabled: boolean) =>
  Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(enabled)));

export const PolicyFeatureSettings = Schema.Struct({
  documents: featureToggle(DEFAULT_FEATURE_TOGGLES.documents),
  roles: featureToggle(DEFAULT_FEATURE_TOGGLES.roles),
  board: featureToggle(DEFAULT_FEATURE_TOGGLES.board),
  mail: featureToggle(DEFAULT_FEATURE_TOGGLES.mail),
  planning: featureToggle(DEFAULT_FEATURE_TOGGLES.planning),
  delegation: featureToggle(DEFAULT_FEATURE_TOGGLES.delegation),
  orchestration: featureToggle(DEFAULT_FEATURE_TOGGLES.orchestration),
  boardAutomation: featureToggle(DEFAULT_FEATURE_TOGGLES.boardAutomation),
  sidebarForest: featureToggle(DEFAULT_FEATURE_TOGGLES.sidebarForest),
  chatExtensions: featureToggle(DEFAULT_FEATURE_TOGGLES.chatExtensions),
  vcs: featureToggle(DEFAULT_FEATURE_TOGGLES.vcs),
  pi: featureToggle(DEFAULT_FEATURE_TOGGLES.pi),
  kimi: featureToggle(DEFAULT_FEATURE_TOGGLES.kimi),
  usage: featureToggle(DEFAULT_FEATURE_TOGGLES.usage),
  files: featureToggle(DEFAULT_FEATURE_TOGGLES.files),
});
export type PolicyFeatureSettings = typeof PolicyFeatureSettings.Type;

const BUILTIN_DOCUMENT_SOURCE: PolicyDocumentSource = { kind: "builtin" };

const documentSource = () =>
  PolicyDocumentSourceSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(BUILTIN_DOCUMENT_SOURCE)),
  );

/** One source per policy document; every key defaults to the bundled template. */
export const PolicyDocumentsSettings = Schema.Struct({
  routingPolicy: documentSource(),
  roles: documentSource(),
  leadSkills: documentSource(),
});
export type PolicyDocumentsSettings = typeof PolicyDocumentsSettings.Type;

export const PoliciesSettings = Schema.Struct({
  documents: PolicyDocumentsSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  applyExternalEdits: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  features: PolicyFeatureSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type PoliciesSettings = typeof PoliciesSettings.Type;

export const DEFAULT_POLICY_SETTINGS: PoliciesSettings = Schema.decodeSync(PoliciesSettings)({});

const decodePoliciesSettings = Schema.decodeUnknownOption(PoliciesSettings);
const decodeProjectPolicyDocumentOverride = Schema.decodeUnknownOption(
  Schema.Struct({
    key: PolicyDocumentKey,
    source: PolicyDocumentSourceSchema,
  }),
);

/** Strict decode of `ft3.policies`; unknown keys (including retired `architect`) are dropped. */
export function decodePolicySettings(raw: unknown): Option.Option<PoliciesSettings> {
  return decodePoliciesSettings(raw);
}

/** Unknown or corrupt stored values fall back to defaults instead of failing startup. */
export function readPolicySettings(
  ft3Namespace: Readonly<Record<string, unknown>> | undefined,
): PoliciesSettings {
  const raw = ft3Namespace?.[POLICY_SETTINGS_NAMESPACE];
  return Option.getOrElse(decodePolicySettings(raw), () => ({ ...DEFAULT_POLICY_SETTINGS }));
}

/**
 * The generic per-project override: at most one policy document. The project
 * value takes precedence over the environment source for that document only.
 */
export const ProjectPolicyDocumentOverride = Schema.Struct({
  key: PolicyDocumentKey,
  source: PolicyDocumentSourceSchema,
});
export type ProjectPolicyDocumentOverride = typeof ProjectPolicyDocumentOverride.Type;

export function decodeProjectPolicyDocumentOverrideValue(
  raw: unknown,
): Option.Option<ProjectPolicyDocumentOverride> {
  return decodeProjectPolicyDocumentOverride(raw);
}

/** Effective sources: the environment setting, with the project's one document replacing its key. */
export function resolvePolicyDocumentSources(
  settings: PoliciesSettings,
  projectOverride?: ProjectPolicyDocumentOverride | null,
): Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>> {
  const sources: Record<PolicyDocumentKey, PolicyDocumentSource> = { ...settings.documents };
  if (projectOverride !== undefined && projectOverride !== null) {
    sources[projectOverride.key] = projectOverride.source;
  }
  return sources;
}

/** Requirement validity input for `resolveFeatureStates`, keyed by policy requirement. */
export type PolicyRequirementValidity = Readonly<Partial<Record<PolicyRequirementId, boolean>>>;
