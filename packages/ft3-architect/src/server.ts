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
  architect_create_or_get: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.createOrGet(scope, input);
    }),
  ),
  architect_replace: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.replace(scope, input);
    }),
  ),
  architect_detach: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.detach(scope, input);
    }),
  ),
  architecture_review_request: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.requestReview(scope, input);
    }),
  ),
  architecture_review_answer: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.answerReview(scope, input);
    }),
  ),
  architecture_review_cancel: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.cancelReview(scope, input);
    }),
  ),
  prepare_coordinator_publication: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.prepareCoordinatorPublication(scope, input);
    }),
  ),
  publish_to_coordinator: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ArchitectService.ArchitectService;
      return yield* service.publishToCoordinator(scope, input);
    }),
  ),
});

export const layer = toolkitRegistration(toolkit, handlers).pipe(
  Layer.provide(ArchitectService.layer),
  Layer.provide(ArchitectRepository.layer),
  Layer.provide(BoardRepository.layer),
);
