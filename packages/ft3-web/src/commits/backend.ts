import { FT3_VCS_WS_METHODS as WS_METHODS } from "@t3tools/ft3-vcs/rpc-contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export function createCommitsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    listCommitHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ft3-vcs:list-commit-history",
      tag: WS_METHODS.vcsListCommitHistory,
    }),
  };
}
