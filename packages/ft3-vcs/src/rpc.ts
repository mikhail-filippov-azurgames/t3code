import { FT3_VCS_WS_METHODS } from "./rpc-contracts.ts";
export { FT3_VCS_WS_METHODS, ft3VcsRpcs, ft3VcsRpcScopes } from "./rpc-contracts.ts";
import * as Effect from "effect/Effect";

import * as CommitHistoryService from "./CommitHistoryService.ts";
import * as Contracts from "./contracts.ts";

export const ft3VcsRpcServiceLayer = CommitHistoryService.layer;

export const ft3VcsRpcHandlers = {
  [FT3_VCS_WS_METHODS.vcsListCommitHistory]: (input: Contracts.VcsCommitHistoryInput) =>
    Effect.gen(function* () {
      const service = yield* CommitHistoryService.CommitHistoryService;
      return yield* service.listCommitHistory(input);
    }),
  [FT3_VCS_WS_METHODS.vcsListRefs]: (input: Contracts.VcsRefsListInput) =>
    Effect.gen(function* () {
      const service = yield* CommitHistoryService.CommitHistoryService;
      return yield* service.listRefs(input);
    }),
  [FT3_VCS_WS_METHODS.vcsGetCommitDiff]: (input: Contracts.VcsCommitDiffInput) =>
    Effect.gen(function* () {
      const service = yield* CommitHistoryService.CommitHistoryService;
      return yield* service.getCommitDiff(input);
    }),
};
