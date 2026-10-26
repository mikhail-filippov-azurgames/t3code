import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as ArchitectService from "./ArchitectService.ts";
import * as Contracts from "./contracts.ts";

export const FT3_ARCHITECT_WS_METHODS = {
  getCoordinatorArchitectSidebar: "orchestration.getCoordinatorArchitectSidebar",
  getCoordinatorArchitectSidebarByArchitect:
    "orchestration.getCoordinatorArchitectSidebarByArchitect",
  publishArchitectPublication: "orchestration.publishArchitectPublication",
} as const;

const ArchitectRpcError = Schema.Union([
  Contracts.ArchitectMcpFailure,
  EnvironmentAuthorizationError,
]);

export const architectRpcs = [
  Rpc.make(FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebar, {
    payload: Contracts.ArchitectGetCoordinatorSidebarInput,
    success: Contracts.ArchitectCoordinatorArchitectSidebarSnapshot,
    error: ArchitectRpcError,
  }),
  Rpc.make(FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebarByArchitect, {
    payload: Contracts.ArchitectGetSidebarByArchitectInput,
    success: Contracts.ArchitectCoordinatorArchitectSidebarSnapshot,
    error: ArchitectRpcError,
  }),
  Rpc.make(FT3_ARCHITECT_WS_METHODS.publishArchitectPublication, {
    payload: Contracts.ArchitectHumanPublicationInput,
    success: Contracts.ArchitectHumanPublicationResult,
    error: ArchitectRpcError,
  }),
] as const;

export const architectRpcScopes = {
  [FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebar]: AuthOrchestrationReadScope,
  [FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebarByArchitect]: AuthOrchestrationReadScope,
  [FT3_ARCHITECT_WS_METHODS.publishArchitectPublication]: AuthOrchestrationOperateScope,
} as const;

export const architectRpcServiceLayer = ArchitectService.layer.pipe(
  Layer.provide(ArchitectRepository.layer),
  Layer.provide(BoardRepository.layer),
);

export const architectRpcHandlers = {
  [FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebar]: (
    input: Contracts.ArchitectGetCoordinatorSidebarInput,
  ) =>
    Effect.gen(function* () {
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.getCoordinatorArchitectSidebar(input);
    }),
  [FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebarByArchitect]: (
    input: Contracts.ArchitectGetSidebarByArchitectInput,
  ) =>
    Effect.gen(function* () {
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.getCoordinatorArchitectSidebarByArchitect(input);
    }),
  [FT3_ARCHITECT_WS_METHODS.publishArchitectPublication]: (
    input: Contracts.ArchitectHumanPublicationInput,
  ) =>
    Effect.gen(function* () {
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.publishHumanPublication(input);
    }),
};
