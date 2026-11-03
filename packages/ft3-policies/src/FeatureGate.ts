/**
 * The single server guard for feature toggles: resolves the `ft3.policies`
 * registry against live settings and refuses an ineffective feature with the
 * Policies reason. Requirement validity arrives with the document loader.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import {
  type FeatureId,
  FeatureId as FeatureIdSchema,
  type FeatureOffReason,
  type FeatureResolution,
  PolicyRequirementId as PolicyRequirementIdSchema,
  resolveFeatureStates,
} from "./contracts.ts";
import { readPolicySettings } from "./settings.ts";

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
    /** Every feature resolved once from the current settings. */
    readonly states: Effect.Effect<Readonly<Record<FeatureId, FeatureResolution>>>;
    /** The effective state and, when off, why. */
    readonly state: (feature: FeatureId) => Effect.Effect<FeatureResolution>;
    readonly isEffective: (feature: FeatureId) => Effect.Effect<boolean>;
    /** Refuses when the feature is ineffective; the design's only server guard. */
    readonly require: (feature: FeatureId) => Effect.Effect<void, FeatureDisabledError>;
  }
>()("@t3tools/ft3-policies/FeatureGate") {}

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

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  const states = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    return resolveFeatureStates({ requested: readPolicySettings(settings.ft3).features });
  });

  const state = Effect.fn("FeatureGate.state")(function* (feature: FeatureId) {
    const resolved = yield* states;
    return resolved[feature];
  });

  const isEffective = Effect.fn("FeatureGate.isEffective")(function* (feature: FeatureId) {
    const resolved = yield* states;
    return resolved[feature].effectiveEnabled;
  });

  const require = Effect.fn("FeatureGate.require")(function* (feature: FeatureId) {
    const resolved = yield* states;
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
