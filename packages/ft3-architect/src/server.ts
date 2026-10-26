import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toolkitRegistration } from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../apps/server/src/mcp/McpToolAccess.ts";
import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as ArchitectService from "./ArchitectService.ts";
import { toolkit } from "./tools.ts";

const handlers = McpToolAccess.toLayer(toolkit, {
  get_coordinator_binding: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.getBinding(scope, input);
    }),
  ),
  list_architecture_reviews: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.listReviews(scope, input);
    }),
  ),
});

export const layer = toolkitRegistration(toolkit, handlers).pipe(
  Layer.provide(ArchitectService.layer),
  Layer.provide(ArchitectRepository.layer),
  Layer.provide(BoardRepository.layer),
);
