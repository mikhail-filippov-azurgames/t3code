import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { FT3_ZAVOD_WS_METHODS } from "@t3tools/ft3-host/rpc-contracts";
import type { Atom } from "effect/reactivity";

export function createZavodEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    detect: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:zavod:detect",
      tag: FT3_ZAVOD_WS_METHODS.zavodDetect,
      staleTimeMs: 5_000,
      refreshIntervalMs: 30_000,
      idleTtlMs: 60_000,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:zavod:connect",
      tag: FT3_ZAVOD_WS_METHODS.zavodConnect,
    }),
    copyPersonal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:zavod:copyPersonal",
      tag: FT3_ZAVOD_WS_METHODS.zavodCopyPersonal,
    }),
  };
}
