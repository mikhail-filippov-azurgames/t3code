import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as Contracts from "./contracts.ts";

export const FT3_BOARD_WS_METHODS = {
  boardOrchestratorsList: "board.orchestrators.list",
  boardOrchestratorAdd: "board.orchestrator.add",
  boardOrchestratorRemove: "board.orchestrator.remove",
  boardOrchestratorResendBrief: "board.orchestrator.resendBrief",
  boardResolve: "board.resolve",
  boardExecutorDelegations: "board.executorDelegations",
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
  Rpc.make(FT3_BOARD_WS_METHODS.boardExecutorDelegations, {
    payload: Contracts.BoardExecutorDelegationsInput,
    success: Contracts.BoardExecutorDelegationsResult,
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
  [FT3_BOARD_WS_METHODS.boardExecutorDelegations]: AuthOrchestrationReadScope,
  [FT3_BOARD_WS_METHODS.boardOrchestratorAdd]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardOrchestratorRemove]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardOrchestratorResendBrief]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardCreate]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardStart]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardUpdate]: AuthOrchestrationOperateScope,
  [FT3_BOARD_WS_METHODS.boardDelete]: AuthOrchestrationOperateScope,
} as const;
