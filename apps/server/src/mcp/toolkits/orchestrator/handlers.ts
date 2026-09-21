import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "./service.ts";
import { OrchestratorMcpToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const service = yield* OrchestratorMcpService;
  return OrchestratorMcpToolkit.of({
    orchestrator_capabilities: () =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, service.capabilities),
    delegate_task: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.delegateTask(scope, input),
      ),
    task_status: ({ taskId }) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.taskStatus(scope, taskId),
      ),
    task_wait: ({ taskId, timeoutMs }) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.taskWait(scope, taskId, timeoutMs),
      ),
    task_cancel: ({ taskId }) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.taskCancel(scope, taskId),
      ),
    switch_provider: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.switchProvider(scope, input),
      ),
    board_create_card: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.boardCreateCard(scope, input),
      ),
    board_update_card: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.boardUpdateCard(scope, input),
      ),
    board_delete_card: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.boardDeleteCard(scope, input),
      ),
    board_list_cards: () =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.boardListCards(scope),
      ),
  });
});

export const OrchestratorMcpToolkitHandlersLive = OrchestratorMcpToolkit.toLayer(make);
