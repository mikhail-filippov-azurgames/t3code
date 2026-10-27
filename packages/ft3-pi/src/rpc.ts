import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makePiInferenceControl } from "./control.ts";
import { piInferenceServerManager } from "./inferenceServer.ts";
import {
  FT3_PI_WS_METHODS,
  type PiBonsaiPresetApplyInput,
  type PiBonsaiPresetDetectInput,
  type PiInferenceServerInput,
} from "./rpc-contracts.ts";

export { FT3_PI_WS_METHODS, piRpcScopes, piRpcs } from "./rpc-contracts.ts";

const control = makePiInferenceControl({ manager: piInferenceServerManager });

export const piRpcHandlers = {
  [FT3_PI_WS_METHODS.piInferenceServerStatus]: (input: PiInferenceServerInput) =>
    Effect.promise(() => control.status(input.instanceId, input.model)),
  [FT3_PI_WS_METHODS.piInferenceServerStart]: (input: PiInferenceServerInput) =>
    Effect.promise(() => control.start(input.instanceId, input.model)),
  [FT3_PI_WS_METHODS.piInferenceServerStop]: (input: PiInferenceServerInput) =>
    Effect.promise(() => control.stop(input.instanceId, input.model)),
  [FT3_PI_WS_METHODS.piBonsaiPresetDetect]: (input: PiBonsaiPresetDetectInput) =>
    Effect.promise(() => control.detectPreset(input.rootPath)),
  [FT3_PI_WS_METHODS.piBonsaiPresetApply]: (input: PiBonsaiPresetApplyInput) =>
    Effect.promise(() => control.applyPreset(input.instanceId, input.rootPath)),
};

export const piRpcServiceLayer = Layer.empty;
