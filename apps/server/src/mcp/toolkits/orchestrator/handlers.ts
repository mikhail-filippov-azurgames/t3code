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
    send_to_task: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.sendToTask(scope, input),
      ),
    task_list: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.taskList(scope, input),
      ),
    task_search: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.taskSearch(scope, input),
      ),
    task_read: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.taskRead(scope, input),
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
    architect_create_or_get: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.architectCreateOrGet(scope, input),
      ),
    architect_replace: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.architectReplace(scope, input),
      ),
    architect_detach: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.architectDetach(scope, input),
      ),
    architecture_review_request: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.architectureReviewRequest(scope, input),
      ),
    architecture_review_answer: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.architectureReviewAnswer(scope, input),
      ),
    architecture_review_cancel: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.architectureReviewCancel(scope, input),
      ),
    publish_to_coordinator: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.publishToCoordinator(scope, input),
      ),
    get_coordinator_binding: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.getCoordinatorBinding(scope, input),
      ),
    list_architecture_reviews: (input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        service.listArchitectureReviews(scope, input),
      ),
  });
});

export const OrchestratorMcpToolkitHandlersLive = OrchestratorMcpToolkit.toLayer(make);
