import { FT3_BOARD_WS_METHODS } from "./rpc-contracts.ts";
export { FT3_BOARD_WS_METHODS, boardRpcs, boardRpcScopes } from "./rpc-contracts.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DelegatedTaskSummaryRepository from "../../ft3-orchestration/src/DelegatedTaskSummaryRepository.ts";
import * as TaskHandoffService from "../../ft3-orchestration/src/TaskHandoffService.ts";
import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";
import * as BoardDelegationService from "./BoardDelegationService.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardSummaryHistoryService from "./BoardSummaryHistoryService.ts";
import * as Contracts from "./contracts.ts";
import { PlanService, type PlanError } from "./PlanService.ts";

export { BoardSummaryHistoryService } from "./BoardSummaryHistoryService.ts";

const taskQueryLayer = TaskQueryService.layer.pipe(
  Layer.provide(TaskHandoffService.layer),
  Layer.provide(DelegatedTaskSummaryRepository.layer),
);

const boardDelegationServiceLayer = BoardDelegationService.layer.pipe(
  Layer.provide(BoardRepository.layer),
  Layer.provide(taskQueryLayer),
);

// The `board.list` handler also reads PlanService; the composition that owns
// this layer provides it (the host merges it after `docsServiceLayer`, whose
// DocsService the plan summaries need). The MCP card tools stay on BoardService.
export const boardRpcServiceLayer = Layer.mergeAll(
  BoardService.layer.pipe(Layer.provide(BoardRepository.layer)),
  boardDelegationServiceLayer,
  BoardSummaryHistoryService.layer.pipe(
    Layer.provide(taskQueryLayer),
    Layer.provide(BoardRepository.layer),
  ),
);

/**
 * The web group reports board failures as BoardMcpFailure; a plan failure
 * reads as the matching board failure for the whole list.
 */
const planFailureCode = (failure: PlanError): Contracts.BoardMcpFailure["code"] => {
  switch (failure.code) {
    case "planning_disabled":
      return "feature_disabled";
    case "plan_document_denied":
      return "capability_denied";
    case "plan_not_found":
    case "plan_card_not_found":
      return "task_not_found";
    case "plan_store_failed":
    case "plan_document_failed":
      return "orchestration_error";
    default:
      return "invalid_request";
  }
};

export const boardRpcHandlers = {
  [FT3_BOARD_WS_METHODS.boardOrchestratorsList]: Effect.fn("BoardRpc.orchestratorsList")(
    function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.listOrchestrators();
    },
  ),
  [FT3_BOARD_WS_METHODS.boardOrchestratorAdd]: Effect.fn("BoardRpc.orchestratorAdd")(function* (
    input: Contracts.BoardOrchestratorAddInput,
  ) {
    const service = yield* BoardService.BoardService;
    return yield* service.markOrchestrator(input);
  }),
  [FT3_BOARD_WS_METHODS.boardOrchestratorRemove]: Effect.fn("BoardRpc.orchestratorRemove")(
    function* (input: Contracts.BoardOrchestratorRemoveInput) {
      const service = yield* BoardService.BoardService;
      return yield* service.unmarkOrchestrator(input);
    },
  ),
  [FT3_BOARD_WS_METHODS.boardOrchestratorResendBrief]: Effect.fn(
    "BoardRpc.orchestratorResendBrief",
  )(function* (input: Contracts.BoardOrchestratorResendBriefInput) {
    const service = yield* BoardService.BoardService;
    return yield* service.resendBrief(input);
  }),
  [FT3_BOARD_WS_METHODS.boardResolve]: Effect.fn("BoardRpc.resolve")(function* (
    input: Contracts.BoardCardResolveInput,
  ) {
    const service = yield* BoardService.BoardService;
    return yield* service.resolveCards(input);
  }),
  [FT3_BOARD_WS_METHODS.boardExecutorDelegations]: Effect.fn("BoardRpc.executorDelegations")(
    function* (input: Contracts.BoardExecutorDelegationsInput) {
      const service = yield* BoardDelegationService.BoardDelegationService;
      return yield* service.list(input);
    },
  ),
  [FT3_BOARD_WS_METHODS.boardDelegatedTaskSummaryHistory]: Effect.fn(
    "BoardRpc.delegatedTaskSummaryHistory",
  )(function* (input: Contracts.BoardDelegatedTaskSummaryHistoryInput) {
    const service = yield* BoardSummaryHistoryService.BoardSummaryHistoryService;
    return yield* service.history(input);
  }),
  [FT3_BOARD_WS_METHODS.boardList]: Effect.fn("BoardRpc.list")(function* (
    input: Contracts.BoardListInput,
  ) {
    const service = yield* BoardService.BoardService;
    const plans = yield* PlanService;
    const result = yield* service.listBoard(input);
    const summaries = yield* plans.listSummaries().pipe(
      Effect.mapError(
        (failure): Contracts.BoardMcpFailure =>
          new Contracts.BoardMcpFailure({
            code: planFailureCode(failure),
            message: failure.message,
          }),
      ),
    );
    return { ...result, plans: summaries };
  }),
  [FT3_BOARD_WS_METHODS.boardCreate]: Effect.fn("BoardRpc.create")(function* (
    input: Contracts.BoardCreateInput,
  ) {
    const service = yield* BoardService.BoardService;
    return yield* service.createHumanCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardStart]: Effect.fn("BoardRpc.start")(function* (
    input: Contracts.BoardStartInput,
  ) {
    const service = yield* BoardService.BoardService;
    return yield* service.startCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardUpdate]: Effect.fn("BoardRpc.update")(function* (
    input: Contracts.BoardUpdateInput,
  ) {
    const service = yield* BoardService.BoardService;
    return yield* service.updateHumanCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardDelete]: Effect.fn("BoardRpc.delete")(function* (
    input: Contracts.BoardDeleteInput,
  ) {
    const service = yield* BoardService.BoardService;
    return yield* service.deleteHumanCard(input);
  }),
};
