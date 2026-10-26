import { FT3_ARCHITECT_WS_METHODS } from "./rpc-contracts.ts";
export { FT3_ARCHITECT_WS_METHODS, architectRpcs, architectRpcScopes } from "./rpc-contracts.ts";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as ArchitectService from "./ArchitectService.ts";
import * as Contracts from "./contracts.ts";

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
