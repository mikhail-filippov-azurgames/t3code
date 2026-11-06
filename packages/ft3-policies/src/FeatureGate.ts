/**
 * The single server guard for feature toggles: resolves the `ft3.policies`
 * registry against live settings and the applied documents' requirement
 * validity — per project when a projectId is given — and refuses an
 * ineffective feature with the Policies reason.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ThreadId, type ProjectId } from "@t3tools/contracts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import {
  type FeatureId,
  FeatureId as FeatureIdSchema,
  type FeatureOffReason,
  type FeatureResolution,
  PolicyRequirementId as PolicyRequirementIdSchema,
  resolveFeatureStates,
} from "./contracts.ts";
import { PolicyChangeTracker } from "./policyChangeTracker.ts";
import {
  decodeProjectFeatureTogglesOverrideValue,
  decodeProjectPolicyDocumentOverrideValue,
  type ProjectFeatureTogglesOverride,
  type ProjectPolicyDocumentOverride,
  readPolicySettings,
  resolveRequestedFeatures,
} from "./settings.ts";

/** Why a call was refused: the requested toggle is off, or a reason the gate resolved. */
const FEATURE_DISABLED_CODES = [
  "feature_disabled",
  "feature_dependency_off",
  "feature_document_off",
] as const;

export class FeatureDisabledError extends Schema.TaggedError<FeatureDisabledError>()(
  "FeatureDisabledError",
  {
    feature: FeatureIdSchema,
    code: Schema.Literals(FEATURE_DISABLED_CODES),
    dependency: Schema.optionalKey(FeatureIdSchema),
    requirement: Schema.optionalKey(PolicyRequirementIdSchema),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "feature_disabled":
        return `${this.feature} is off. Open Settings → Policies.`;
      case "feature_dependency_off":
        return `${this.feature} is off because ${this.dependency ?? ""} is off.`;
      case "feature_document_off":
        return `${this.feature} is off: ${this.requirement ?? ""}. Open Settings → Policies.`;
    }
  }
}

export class FeatureGate extends Context.Service<
  FeatureGate,
  {
    /** Every feature resolved once for the environment (no project override). */
    readonly states: Effect.Effect<Readonly<Record<FeatureId, FeatureResolution>>>;
    /** The effective state and, when off, why; a projectId applies its overrides. */
    readonly state: (feature: FeatureId, projectId?: string) => Effect.Effect<FeatureResolution>;
    readonly isEffective: (feature: FeatureId, projectId?: string) => Effect.Effect<boolean>;
    /** Refuses when the feature is ineffective; the design's only server guard. */
    readonly require: (
      feature: FeatureId,
      projectId?: string,
    ) => Effect.Effect<void, FeatureDisabledError>;
  }
>()("@t3tools/ft3-policies/FeatureGate") {}

export const projectIdOfThread = Effect.fn("FeatureGate.projectIdOfThread")(function* (
  threadId: string,
) {
  const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
  if (Option.isNone(threads)) {
    yield* Effect.logDebug("Feature project lookup has no thread service", { threadId });
    return Option.none<ProjectId>();
  }
  const shell = yield* threads.value.getThreadShell(ThreadId.make(threadId)).pipe(
    Effect.tapError((cause) =>
      Effect.logDebug("Feature project lookup failed", { threadId, cause: String(cause) }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (shell === null) {
    yield* Effect.logDebug("Feature project lookup found no thread shell", { threadId });
    return Option.none<ProjectId>();
  }
  return Option.some(shell.projectId);
});

const disabledError = (
  feature: FeatureId,
  reason: FeatureOffReason | null,
): FeatureDisabledError =>
  reason === null
    ? new FeatureDisabledError({ feature, code: "feature_disabled" })
    : reason.code === "feature_dependency_off"
      ? new FeatureDisabledError({
          feature,
          code: "feature_dependency_off",
          dependency: reason.dependency,
        })
      : new FeatureDisabledError({
          feature,
          code: "feature_document_off",
          requirement: reason.requirement,
        });

/** The raw per-project override entries the gate reads out of the server settings. */
type ProjectOverrideEntries = Readonly<
  Record<
    string,
    { readonly ft3PolicyDocuments?: unknown; readonly ft3FeatureToggles?: unknown } | undefined
  >
>;

/** The project's document override, when it decodes; null otherwise (the same rule as PoliciesRpc). */
const projectDocumentOverrideOf = (
  overrides: ProjectOverrideEntries,
  projectId: string | undefined,
): ProjectPolicyDocumentOverride | null => {
  if (projectId === undefined) return null;
  const raw = overrides[projectId]?.ft3PolicyDocuments;
  if (raw === undefined) return null;
  const decoded = decodeProjectPolicyDocumentOverrideValue(raw);
  return Option.isSome(decoded) ? decoded.value : null;
};

/** The project's toggle override, when it decodes; null means inherit (D3). */
const projectTogglesOverrideOf = (
  overrides: ProjectOverrideEntries,
  projectId: string | undefined,
): ProjectFeatureTogglesOverride | null => {
  if (projectId === undefined) return null;
  const raw = overrides[projectId]?.ft3FeatureToggles;
  if (raw === undefined) return null;
  const decoded = decodeProjectFeatureTogglesOverrideValue(raw);
  return Option.isSome(decoded) ? decoded.value : null;
};

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  /**
   * Resolves every feature for one project: environment defaults plus the
   * project's toggle override, against the project scope's requirements when
   * the project overrides a document (the `PoliciesRpc.scopeFor` rule), else
   * the environment scope. An unknown project resolves like the environment.
   */
  const statesFor = Effect.fn("FeatureGate.statesFor")(function* (projectId?: string) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const policies = readPolicySettings(settings.ft3);
    const documentOverride = projectDocumentOverrideOf(
      settings.projectSettingsOverrides,
      projectId,
    );
    const scope = documentOverride !== null && projectId !== undefined ? projectId : undefined;
    const tracker = yield* Effect.serviceOption(PolicyChangeTracker);
    const requirements = Option.isNone(tracker)
      ? {}
      : (yield* tracker.value.snapshot(scope)).requirements;
    return resolveFeatureStates({
      requested: resolveRequestedFeatures(
        policies,
        projectTogglesOverrideOf(settings.projectSettingsOverrides, projectId),
      ),
      requirements,
    });
  });

  /** Every feature resolved once for the environment (no project). */
  const states = statesFor();

  const state = Effect.fn("FeatureGate.state")(function* (feature: FeatureId, projectId?: string) {
    const resolved = yield* statesFor(projectId);
    return resolved[feature];
  });

  const isEffective = Effect.fn("FeatureGate.isEffective")(function* (
    feature: FeatureId,
    projectId?: string,
  ) {
    const resolved = yield* statesFor(projectId);
    return resolved[feature].effectiveEnabled;
  });

  const require = Effect.fn("FeatureGate.require")(function* (
    feature: FeatureId,
    projectId?: string,
  ) {
    const resolved = yield* statesFor(projectId);
    const resolvedState = resolved[feature];
    if (resolvedState.effectiveEnabled) return;
    return yield* disabledError(feature, resolvedState.offReason);
  });

  return FeatureGate.of({
    states,
    state,
    isEffective,
    require,
  });
});

/** Reads `ft3.policies.features` from the server settings on every call. */
export const layer = Layer.effect(FeatureGate, make);
