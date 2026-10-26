import { FT3_PI_WS_METHODS as WS_METHODS } from "@t3tools/ft3-pi/rpc-contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export function createPiInferenceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pi:inference-status",
      tag: WS_METHODS.piInferenceServerStatus,
      staleTimeMs: 2_500,
      refreshIntervalMs: 2_500,
      idleTtlMs: 60_000,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pi:inference-start",
      tag: WS_METHODS.piInferenceServerStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pi:inference-stop",
      tag: WS_METHODS.piInferenceServerStop,
    }),
  };
}
