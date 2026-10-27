import { FT3_VCS_WS_METHODS as WS_METHODS } from "@t3tools/ft3-vcs/rpc-contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export function createCommitsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    listCommitHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ft3-vcs:list-commit-history",
      tag: WS_METHODS.vcsListCommitHistory,
    }),
    listRefs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ft3-vcs:list-refs",
      tag: WS_METHODS.vcsListRefs,
      staleTimeMs: 5_000,
    }),
    commitDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ft3-vcs:commit-diff",
      tag: WS_METHODS.vcsGetCommitDiff,
      staleTimeMs: 60_000,
    }),
  };
}
