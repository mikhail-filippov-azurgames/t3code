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
  vcsListRefs: "vcs.listRepositoryRefs",
  vcsGetCommitDiff: "vcs.getCommitDiff",
} as const;

const VcsRpcError = Schema.Union([VcsError, EnvironmentAuthorizationError]);

export const ft3VcsRpcs = [
  Rpc.make(FT3_VCS_WS_METHODS.vcsListCommitHistory, {
    payload: Contracts.VcsCommitHistoryInput,
    success: Contracts.VcsCommitHistoryResult,
    error: VcsRpcError,
  }),
  Rpc.make(FT3_VCS_WS_METHODS.vcsListRefs, {
    payload: Contracts.VcsRefsListInput,
    success: Contracts.VcsRefsListResult,
    error: VcsRpcError,
  }),
  Rpc.make(FT3_VCS_WS_METHODS.vcsGetCommitDiff, {
    payload: Contracts.VcsCommitDiffInput,
    success: Contracts.VcsCommitDiffResult,
    error: VcsRpcError,
  }),
] as const;

export const ft3VcsRpcScopes = {
  [FT3_VCS_WS_METHODS.vcsListCommitHistory]: AuthOrchestrationReadScope,
  [FT3_VCS_WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [FT3_VCS_WS_METHODS.vcsGetCommitDiff]: AuthOrchestrationReadScope,
} as const;
