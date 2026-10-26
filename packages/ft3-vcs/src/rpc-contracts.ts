import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  VcsError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import * as Contracts from "./contracts.ts";

export const FT3_VCS_WS_METHODS = {
  vcsListCommitHistory: "vcs.listCommitHistory",
} as const;

const VcsRpcError = Schema.Union([VcsError, EnvironmentAuthorizationError]);

export const ft3VcsRpcs = [
  Rpc.make(FT3_VCS_WS_METHODS.vcsListCommitHistory, {
    payload: Contracts.VcsCommitHistoryInput,
    success: Contracts.VcsCommitHistoryResult,
    error: VcsRpcError,
  }),
] as const;

export const ft3VcsRpcScopes = {
  [FT3_VCS_WS_METHODS.vcsListCommitHistory]: AuthOrchestrationReadScope,
} as const;
