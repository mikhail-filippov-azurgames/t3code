import { FT3_VCS_WS_METHODS } from "./rpc-contracts.ts";
export { FT3_VCS_WS_METHODS, ft3VcsRpcs, ft3VcsRpcScopes } from "./rpc-contracts.ts";
import * as Effect from "effect/Effect";

import * as CommitHistoryService from "./CommitHistoryService.ts";
import * as Contracts from "./contracts.ts";

export const ft3VcsRpcServiceLayer = CommitHistoryService.layer;

export const ft3VcsRpcHandlers = {
  [FT3_VCS_WS_METHODS.vcsListCommitHistory]: Effect.fn("VcsRpc.listCommitHistory")(function* (
    input: Contracts.VcsCommitHistoryInput,
  ) {
    const service = yield* CommitHistoryService.CommitHistoryService;
    return yield* service.listCommitHistory(input);
  }),
  [FT3_VCS_WS_METHODS.vcsListRefs]: Effect.fn("VcsRpc.listRefs")(function* (
    input: Contracts.VcsRefsListInput,
  ) {
    const service = yield* CommitHistoryService.CommitHistoryService;
    return yield* service.listRefs(input);
  }),
  [FT3_VCS_WS_METHODS.vcsGetCommitDiff]: Effect.fn("VcsRpc.getCommitDiff")(function* (
    input: Contracts.VcsCommitDiffInput,
  ) {
    const service = yield* CommitHistoryService.CommitHistoryService;
    return yield* service.getCommitDiff(input);
  }),
  [FT3_VCS_WS_METHODS.vcsResolveCommitMentions]: Effect.fn("VcsRpc.resolveCommitMentions")(
    function* (input: Contracts.VcsResolveCommitMentionsInput) {
      const service = yield* CommitHistoryService.CommitHistoryService;
      return yield* service.resolveCommitMentions(input);
    },
  ),
};
