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
import * as Contracts from "./contracts.ts";

const taskQueryLayer = TaskQueryService.layer.pipe(
  Layer.provide(TaskHandoffService.layer),
  Layer.provide(DelegatedTaskSummaryRepository.layer),
);

const boardDelegationServiceLayer = BoardDelegationService.layer.pipe(
  Layer.provide(BoardRepository.layer),
  Layer.provide(taskQueryLayer),
);

export const boardRpcServiceLayer = Layer.mergeAll(
  BoardService.layer.pipe(Layer.provide(BoardRepository.layer)),
  boardDelegationServiceLayer,
);

export const boardRpcHandlers = {
  [FT3_BOARD_WS_METHODS.boardOrchestratorsList]: () =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.listOrchestrators();
    }),
  [FT3_BOARD_WS_METHODS.boardOrchestratorAdd]: (input: Contracts.BoardOrchestratorAddInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.markOrchestrator(input);
    }),
  [FT3_BOARD_WS_METHODS.boardOrchestratorRemove]: (input: Contracts.BoardOrchestratorRemoveInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.unmarkOrchestrator(input);
    }),
  [FT3_BOARD_WS_METHODS.boardOrchestratorResendBrief]: (
    input: Contracts.BoardOrchestratorResendBriefInput,
  ) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.resendBrief(input);
    }),
  [FT3_BOARD_WS_METHODS.boardResolve]: (input: Contracts.BoardCardResolveInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.resolveCards(input);
    }),
  [FT3_BOARD_WS_METHODS.boardExecutorDelegations]: (
    input: Contracts.BoardExecutorDelegationsInput,
  ) =>
    Effect.gen(function* () {
      const service = yield* BoardDelegationService.BoardDelegationService;
      return yield* service.list(input);
    }),
  [FT3_BOARD_WS_METHODS.boardList]: (input: Contracts.BoardListInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.listBoard(input);
    }),
  [FT3_BOARD_WS_METHODS.boardCreate]: (input: Contracts.BoardCreateInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.createHumanCard(input);
    }),
  [FT3_BOARD_WS_METHODS.boardStart]: (input: Contracts.BoardStartInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.startCard(input);
    }),
  [FT3_BOARD_WS_METHODS.boardUpdate]: (input: Contracts.BoardUpdateInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.updateHumanCard(input);
    }),
  [FT3_BOARD_WS_METHODS.boardDelete]: (input: Contracts.BoardDeleteInput) =>
    Effect.gen(function* () {
      const service = yield* BoardService.BoardService;
      return yield* service.deleteHumanCard(input);
    }),
};
