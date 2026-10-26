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
] as const;

export const piRpcScopes = {
  [FT3_PI_WS_METHODS.piInferenceServerStatus]: AuthOrchestrationReadScope,
  [FT3_PI_WS_METHODS.piInferenceServerStart]: AuthOrchestrationOperateScope,
  [FT3_PI_WS_METHODS.piInferenceServerStop]: AuthOrchestrationOperateScope,
} as const;
