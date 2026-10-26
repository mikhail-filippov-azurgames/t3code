import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import * as Contracts from "./contracts.ts";

export const FT3_BOARD_WS_METHODS = {
  boardOrchestratorsList: "board.orchestrators.list",
  boardOrchestratorAdd: "board.orchestrator.add",
  boardOrchestratorRemove: "board.orchestrator.remove",
  boardOrchestratorResendBrief: "board.orchestrator.resendBrief",
  boardResolve: "board.resolve",
  boardList: "board.list",
  boardCreate: "board.create",
  boardStart: "board.start",
  boardUpdate: "board.update",
  boardDelete: "board.delete",
} as const;

const BoardRpcError = Schema.Union([Contracts.BoardMcpFailure, EnvironmentAuthorizationError]);

export const boardRpcs = [
  Rpc.make(FT3_BOARD_WS_METHODS.boardOrchestratorsList, {
    payload: Contracts.BoardOrchestratorsListInput,
    success: Contracts.BoardOrchestratorsListResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardOrchestratorAdd, {
    payload: Contracts.BoardOrchestratorAddInput,
    success: Contracts.BoardOrchestratorAddResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardOrchestratorRemove, {
    payload: Contracts.BoardOrchestratorRemoveInput,
    success: Contracts.BoardOrchestratorRemoveResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardOrchestratorResendBrief, {
    payload: Contracts.BoardOrchestratorResendBriefInput,
    success: Contracts.BoardOrchestratorResendBriefResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardResolve, {
    payload: Contracts.BoardCardResolveInput,
    success: Contracts.BoardCardResolveResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardList, {
    payload: Contracts.BoardListInput,
    success: Contracts.BoardListResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardCreate, {
    payload: Contracts.BoardCreateInput,
    success: Contracts.BoardCreateResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardStart, {
    payload: Contracts.BoardStartInput,
    success: Contracts.BoardStartResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardUpdate, {
    payload: Contracts.BoardUpdateInput,
    success: Contracts.BoardUpdateResult,
    error: BoardRpcError,
  }),
  Rpc.make(FT3_BOARD_WS_METHODS.boardDelete, {
    payload: Contracts.BoardDeleteInput,
    success: Contracts.BoardDeleteResult,
    error: BoardRpcError,
  }),
] as const;

export const boardRpcScopes = {
  [FT3_BOARD_WS_METHODS.boardOrchestratorsList]: AuthOrchestrationReadScope,
  [FT3_BOARD_WS_METHODS.boardList]: AuthOrchestrationReadScope,
  [FT3_BOARD_WS_METHODS.boardResolve]: AuthOrchestrationReadScope,
  [FT3_BOARD_WS_METHODS.boardOrchestratorAdd]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardOrchestratorRemove]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardOrchestratorResendBrief]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardCreate]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardStart]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardUpdate]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardDelete]: AuthOrchestrationOperateScope,
} as const;

export const boardRpcServiceLayer = BoardService.layer.pipe(Layer.provide(BoardRepository.layer));

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
