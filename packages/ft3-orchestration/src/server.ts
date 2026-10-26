import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { toolkitRegistration } from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../apps/server/src/mcp/McpToolAccess.ts";
import type * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as DelegatedTaskSummaryRepository from "./DelegatedTaskSummaryRepository.ts";
import * as TaskHandoffService from "./TaskHandoffService.ts";
import * as TaskQueryService from "./TaskQueryService.ts";
import { toolkit } from "./tools.ts";

const handlers = McpToolAccess.toLayer(toolkit, {
  task_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* TaskQueryService.TaskQueryService;
      return yield* service.list(scope, input);
    }),
  ),
  task_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* TaskQueryService.TaskQueryService;
      return yield* service.search(scope, input);
    }),
  ),
  task_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* TaskQueryService.TaskQueryService;
      return yield* service.read(scope, input);
    }),
  ),
  task_attach_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* TaskHandoffService.TaskHandoffService;
      return yield* service.attach(scope, input);
    }),
  ),
  task_summary_history: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* TaskQueryService.TaskQueryService;
      return yield* service.history(scope, input);
    }),
  ),
});

export const layer: Layer.Layer<
  never,
  never,
  ThreadManagement.ThreadManagementService | SqlClient.SqlClient
> = toolkitRegistration(toolkit, handlers).pipe(
  Layer.provide(TaskQueryService.layer),
  Layer.provide(TaskHandoffService.layer),
  Layer.provide(DelegatedTaskSummaryRepository.layer),
);
