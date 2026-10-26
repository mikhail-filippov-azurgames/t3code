import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toolkitRegistration } from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../apps/server/src/mcp/McpToolAccess.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import { toolkit } from "./tools.ts";

const handlers = McpToolAccess.toLayer(toolkit, {
  board_create_card: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* BoardService.BoardService;
      return yield* service.create(scope, input);
    }),
  ),
  board_list_cards: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* BoardService.BoardService;
      return yield* service.list(scope, input);
    }),
  ),
  board_update_card: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* BoardService.BoardService;
      return yield* service.update(scope, input);
    }),
  ),
  board_delete_card: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* BoardService.BoardService;
      return yield* service.delete(scope, input);
    }),
  ),
});

export const layer = toolkitRegistration(toolkit, handlers).pipe(
  Layer.provide(BoardService.layer),
  Layer.provide(BoardRepository.layer),
);
