import { FT3_BOARD_WS_METHODS } from "./rpc-contracts.ts";
export { FT3_BOARD_WS_METHODS, boardRpcs, boardRpcScopes } from "./rpc-contracts.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadId } from "@t3tools/contracts";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import * as DelegatedTaskSummaryRepository from "../../ft3-orchestration/src/DelegatedTaskSummaryRepository.ts";
import * as TaskHandoffService from "../../ft3-orchestration/src/TaskHandoffService.ts";
import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";
import * as BoardDelegationService from "./BoardDelegationService.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardSummaryHistoryService from "./BoardSummaryHistoryService.ts";
import * as Contracts from "./contracts.ts";
import { PlanService, planFailureCode, type PlanError } from "./PlanService.ts";

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
  BoardService.layer.pipe(Layer.provide(Layer.mergeAll(BoardRepository.layer, FeatureGate.layer))),
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
export { planFailureCode };

const planFailure = (failure: PlanError): Contracts.BoardMcpFailure =>
  new Contracts.BoardMcpFailure({ code: planFailureCode(failure), message: failure.message });

const mapPlanError = <A>(effect: Effect.Effect<A, PlanError>) =>
  effect.pipe(Effect.mapError(planFailure));

const requireBoardForThread = Effect.fn("BoardRpc.requireBoardForThread")(function* (
  threadId: ThreadId,
) {
  const service = yield* BoardService.BoardService;
  yield* service.requireFeature({ threadId });
});

const requireBoardForEnvironment = Effect.gen(function* () {
  const service = yield* BoardService.BoardService;
  yield* service.requireFeature({});
});

const requireBoardForCard = Effect.fn("BoardRpc.requireBoardForCard")(function* (
  cardId: Contracts.BoardCardId,
) {
  const service = yield* BoardService.BoardService;
  yield* service.requireFeature({ cardId });
});

const requirePlanningForCard = Effect.fn("BoardRpc.requirePlanningForCard")(function* (
  plans: PlanService["Service"],
  cardId: Contracts.BoardCardId,
) {
  yield* plans.requirePlanningEnabled(cardId).pipe(Effect.mapError(planFailure));
});

export const boardRpcHandlers = {
  [FT3_BOARD_WS_METHODS.boardOrchestratorsList]: Effect.fn("BoardRpc.orchestratorsList")(
    function* () {
      yield* requireBoardForEnvironment;
      const service = yield* BoardService.BoardService;
      return yield* service.listOrchestrators();
    },
  ),
  [FT3_BOARD_WS_METHODS.boardOrchestratorAdd]: Effect.fn("BoardRpc.orchestratorAdd")(function* (
    input: Contracts.BoardOrchestratorAddInput,
  ) {
    yield* requireBoardForThread(input.threadId);
    const service = yield* BoardService.BoardService;
    return yield* service.markOrchestrator(input);
  }),
  [FT3_BOARD_WS_METHODS.boardOrchestratorRemove]: Effect.fn("BoardRpc.orchestratorRemove")(
    function* (input: Contracts.BoardOrchestratorRemoveInput) {
      yield* requireBoardForThread(input.threadId);
      const service = yield* BoardService.BoardService;
      return yield* service.unmarkOrchestrator(input);
    },
  ),
  [FT3_BOARD_WS_METHODS.boardOrchestratorResendBrief]: Effect.fn(
    "BoardRpc.orchestratorResendBrief",
  )(function* (input: Contracts.BoardOrchestratorResendBriefInput) {
    yield* requireBoardForThread(input.threadId);
    const service = yield* BoardService.BoardService;
    return yield* service.resendBrief(input);
  }),
  [FT3_BOARD_WS_METHODS.boardResolve]: Effect.fn("BoardRpc.resolve")(function* (
    input: Contracts.BoardCardResolveInput,
  ) {
    const service = yield* BoardService.BoardService;
    const resolved = yield* service.resolveCards(input);
    for (const match of resolved.matches) {
      yield* requireBoardForThread(match.card.orchestratorThreadId);
    }
    for (const detail of resolved.details) {
      yield* requireBoardForThread(detail.card.orchestratorThreadId);
    }
    if (resolved.matches.length === 0 && resolved.details.length === 0) {
      yield* requireBoardForEnvironment;
    }
    return resolved;
  }),
  [FT3_BOARD_WS_METHODS.boardExecutorDelegations]: Effect.fn("BoardRpc.executorDelegations")(
    function* (input: Contracts.BoardExecutorDelegationsInput) {
      yield* requireBoardForCard(input.cardId);
      const service = yield* BoardDelegationService.BoardDelegationService;
      return yield* service.list(input);
    },
  ),
  [FT3_BOARD_WS_METHODS.boardDelegatedTaskSummaryHistory]: Effect.fn(
    "BoardRpc.delegatedTaskSummaryHistory",
  )(function* (input: Contracts.BoardDelegatedTaskSummaryHistoryInput) {
    yield* requireBoardForThread(input.parentThreadId);
    const service = yield* BoardSummaryHistoryService.BoardSummaryHistoryService;
    return yield* service.history(input);
  }),
  [FT3_BOARD_WS_METHODS.boardList]: Effect.fn("BoardRpc.list")(function* (
    input: Contracts.BoardListInput,
  ) {
    yield* requireBoardForEnvironment;
    const service = yield* BoardService.BoardService;
    const plans = yield* PlanService;
    const result = yield* service.listBoard(input);
    const summaries = yield* plans
      .listSummaries({ cardIds: result.cards.map((card) => card.cardId) })
      .pipe(
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
    yield* requireBoardForThread(input.orchestratorThreadId);
    const service = yield* BoardService.BoardService;
    return yield* service.createHumanCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardStart]: Effect.fn("BoardRpc.start")(function* (
    input: Contracts.BoardStartInput,
  ) {
    yield* requireBoardForCard(input.cardId);
    const service = yield* BoardService.BoardService;
    return yield* service.startCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardUpdate]: Effect.fn("BoardRpc.update")(function* (
    input: Contracts.BoardUpdateInput,
  ) {
    yield* requireBoardForCard(input.cardId);
    const service = yield* BoardService.BoardService;
    return yield* service.updateHumanCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardDelete]: Effect.fn("BoardRpc.delete")(function* (
    input: Contracts.BoardDeleteInput,
  ) {
    yield* requireBoardForCard(input.cardId);
    const service = yield* BoardService.BoardService;
    return yield* service.deleteHumanCard(input);
  }),
  [FT3_BOARD_WS_METHODS.boardPlanGet]: Effect.fn("BoardRpc.planGet")(function* (
    input: Contracts.BoardPlanGetInput,
  ) {
    yield* requireBoardForCard(input.cardId);
    const plans = yield* PlanService;
    yield* requirePlanningForCard(plans, input.cardId);
    const detail = yield* mapPlanError(
      plans.readDetail({ cardId: input.cardId, version: "current" }),
    );
    const versions = yield* mapPlanError(plans.listVersions(input.cardId));
    return {
      record: detail.record,
      doc: detail.doc,
      liveSha256: detail.sha256,
      versions: versions.map((version) => ({
        phase: version.phase,
        sha256: version.sha256,
        createdAt: version.createdAt,
      })),
    };
  }),
  [FT3_BOARD_WS_METHODS.boardPlanSetRequired]: Effect.fn("BoardRpc.planSetRequired")(function* (
    input: Contracts.BoardPlanSetRequiredInput,
  ) {
    yield* requireBoardForCard(input.cardId);
    const plans = yield* PlanService;
    yield* requirePlanningForCard(plans, input.cardId);
    if (input.required) {
      return yield* mapPlanError(
        plans.require({
          cardId: input.cardId,
          requiredBy: "human",
          ...(input.reason === undefined || input.reason === null ? {} : { reason: input.reason }),
        }),
      );
    }
    return yield* mapPlanError(plans.withdraw(input.cardId));
  }),
  [FT3_BOARD_WS_METHODS.boardPlanAccept]: Effect.fn("BoardRpc.planAccept")(function* (
    input: Contracts.BoardPlanAcceptInput,
  ) {
    yield* requireBoardForCard(input.cardId);
    const plans = yield* PlanService;
    yield* requirePlanningForCard(plans, input.cardId);
    return yield* mapPlanError(plans.accept({ cardId: input.cardId, sha256: input.sha256 }));
  }),
};
