import { FT3_ARCHITECT_WS_METHODS as WS_METHODS } from "@t3tools/ft3-architect/rpc-contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export function createArchitectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    sidebarSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:architect:coordinator-sidebar",
      tag: WS_METHODS.getCoordinatorArchitectSidebar,
      staleTimeMs: 2_000,
      idleTtlMs: 60_000,
    }),
    sidebarSnapshotByArchitect: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:architect:sidebar-by-architect",
      tag: WS_METHODS.getCoordinatorArchitectSidebarByArchitect,
      staleTimeMs: 2_000,
      idleTtlMs: 60_000,
    }),
    publishArchitectPublication: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:architect:publish-publication",
      tag: WS_METHODS.publishArchitectPublication,
    }),
  };
}
