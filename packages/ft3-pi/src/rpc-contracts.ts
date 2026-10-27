import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

export const FT3_PI_WS_METHODS = {
  piInferenceServerStatus: "pi.inferenceServer.status",
  piInferenceServerStart: "pi.inferenceServer.start",
  piInferenceServerStop: "pi.inferenceServer.stop",
  piBonsaiPresetDetect: "pi.bonsaiPreset.detect",
  piBonsaiPresetApply: "pi.bonsaiPreset.apply",
} as const;

export const PiInferenceServerInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: Schema.optionalKey(Schema.String),
});
export type PiInferenceServerInput = typeof PiInferenceServerInput.Type;

export const PiInferenceServerStatus = Schema.Struct({
  instanceId: Schema.String,
  phase: Schema.Literals(["stopped", "starting", "ready", "failed"]),
  ready: Schema.Boolean,
  endpoint: Schema.String,
  model: Schema.NullOr(Schema.String),
  modelIds: Schema.Array(Schema.String),
  owned: Schema.Boolean,
  canStart: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type PiInferenceServerStatus = typeof PiInferenceServerStatus.Type;

/** Bonsai launch config discovered on the FT3 host; paths are suggestions, never defaults. */
export const PiBonsaiPreset = Schema.Struct({
  executablePath: Schema.NonEmptyString,
  modelPath: Schema.NonEmptyString,
  baseUrl: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
});
export type PiBonsaiPreset = typeof PiBonsaiPreset.Type;

export const PiBonsaiPresetDetectInput = Schema.Struct({
  rootPath: Schema.optionalKey(Schema.String),
});
export type PiBonsaiPresetDetectInput = typeof PiBonsaiPresetDetectInput.Type;

export const PiBonsaiPresetApplyInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  rootPath: Schema.optionalKey(Schema.String),
});
export type PiBonsaiPresetApplyInput = typeof PiBonsaiPresetApplyInput.Type;

export const piRpcs = [
  Rpc.make(FT3_PI_WS_METHODS.piInferenceServerStatus, {
    payload: PiInferenceServerInput,
    success: PiInferenceServerStatus,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_PI_WS_METHODS.piInferenceServerStart, {
    payload: PiInferenceServerInput,
    success: PiInferenceServerStatus,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_PI_WS_METHODS.piInferenceServerStop, {
    payload: PiInferenceServerInput,
    success: PiInferenceServerStatus,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_PI_WS_METHODS.piBonsaiPresetDetect, {
    payload: PiBonsaiPresetDetectInput,
    success: Schema.NullOr(PiBonsaiPreset),
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_PI_WS_METHODS.piBonsaiPresetApply, {
    payload: PiBonsaiPresetApplyInput,
    success: Schema.NullOr(PiBonsaiPreset),
    error: EnvironmentAuthorizationError,
  }),
] as const;

export const piRpcScopes = {
  [FT3_PI_WS_METHODS.piInferenceServerStatus]: AuthOrchestrationReadScope,
  [FT3_PI_WS_METHODS.piInferenceServerStart]: AuthOrchestrationOperateScope,
  [FT3_PI_WS_METHODS.piInferenceServerStop]: AuthOrchestrationOperateScope,
  [FT3_PI_WS_METHODS.piBonsaiPresetDetect]: AuthOrchestrationReadScope,
  [FT3_PI_WS_METHODS.piBonsaiPresetApply]: AuthOrchestrationOperateScope,
} as const;
