import {
  ORCHESTRATOR_MCP_TOOL_NAMES,
  OrchestratorMcpArchitectCreateOrGetInput,
  OrchestratorMcpArchitectCreateOrGetResult,
  OrchestratorMcpArchitectDetachInput,
  OrchestratorMcpArchitectDetachResult,
  OrchestratorMcpArchitectReplaceInput,
  OrchestratorMcpArchitectReplaceResult,
  OrchestratorMcpBoardCreateCardInput,
  OrchestratorMcpBoardCreateCardResult,
  OrchestratorMcpBoardDeleteCardInput,
  OrchestratorMcpBoardDeleteCardResult,
  OrchestratorMcpBoardListCardsInput,
  OrchestratorMcpBoardListCardsResult,
  OrchestratorMcpBoardUpdateCardInput,
  OrchestratorMcpBoardUpdateCardResult,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpGetCoordinatorBindingInput,
  OrchestratorMcpGetCoordinatorBindingResult,
  OrchestratorMcpListArchitectureReviewsInput,
  OrchestratorMcpListArchitectureReviewsResult,
  OrchestratorMcpPublishToCoordinatorInput,
  OrchestratorMcpPublishToCoordinatorResult,
  OrchestratorMcpReviewAnswerInput,
  OrchestratorMcpReviewAnswerResult,
  OrchestratorMcpReviewCancelInput,
  OrchestratorMcpReviewCancelResult,
  OrchestratorMcpReviewRequestInput,
  OrchestratorMcpReviewRequestResult,
  OrchestratorMcpSendToTaskInput,
  OrchestratorMcpSendToTaskResult,
  OrchestratorMcpSwitchProviderInput,
  OrchestratorMcpSwitchProviderResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskListInput,
  OrchestratorMcpTaskListResult,
  OrchestratorMcpTaskReadInput,
  OrchestratorMcpTaskReadResult,
  OrchestratorMcpTaskSearchInput,
  OrchestratorMcpTaskSearchResult,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpTaskStatusResult,
  OrchestratorMcpTaskWaitInput,
  OrchestratorMcpTaskWaitResult,
} from "@t3tools/contracts";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "./service.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

export const OrchestratorCapabilitiesTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.capabilities, {
  description:
    "List provider instances and models that this active T3 Code turn may delegate to, together with the frozen parent permission envelope and inherited workspace policy.",
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List delegation capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DelegateTaskTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.delegateTask, {
  description:
    "Create one ordinary child T3 Code thread in this thread's project and inherited worktree, then start exactly one provider turn using the selected provider/model. Use this instead of an in-process subagent when the user asks for a new or separate T3 thread. Call orchestrator_capabilities first and select only a provider with delegatable=true. An optional OCL handoff is stored in durable lineage and is not appended to the child message; put every child-facing instruction in prompt. When the child reaches a terminal state, the server announces it as a durable message in this parent thread; do not sit in a long task_wait loop waiting for that announcement. Use task_status or a short bounded task_wait only when you need to join or inspect exact details. Reuse the same idempotencyKey only for an exact retry. A typed pre-spawn validation failure creates no child. For any other failure without a taskId, do not assume that no child work exists: retry the exact request with the same idempotencyKey to recover its deterministic task.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Delegate task to a T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SendToTaskTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.sendToTask, {
  description:
    "Send a follow-up message to a delegated child thread owned by this parent. The child keeps its current provider/model selection and frozen permission envelope; the new ordinary turn requests followUpBehavior=queue and reuses the child's existing provider session. The runtime may adapt queue behavior for providers that cannot queue on one session. Reuse the same idempotencyKey only for an exact retry. The result identifies this follow-up message and command. task_status and task_cancel continue to address only the original delegated turn.",
  parameters: OrchestratorMcpSendToTaskInput,
  success: OrchestratorMcpSendToTaskResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Send message to delegated task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TaskListTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskList, {
  description:
    "List direct delegated children of this parent, including archived children, with latest turn and bounded summary. Results are scoped to this parent.",
  parameters: OrchestratorMcpTaskListInput,
  success: OrchestratorMcpTaskListResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List delegated tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TaskSearchTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskSearch, {
  description:
    "Search this parent's delegated children by exact task ID/path or text in role, title, and summaries. Prefer this over relying on remembered task IDs.",
  parameters: OrchestratorMcpTaskSearchInput,
  success: OrchestratorMcpTaskSearchResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Search delegated tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TaskReadTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskRead, {
  description:
    "Read a paginated transcript for one child owned by this parent, including archived children.",
  parameters: OrchestratorMcpTaskReadInput,
  success: OrchestratorMcpTaskReadResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read delegated task transcript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TaskStatusTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskStatus, {
  description:
    "Read the delegated task's exact provider-turn state and result. The lookup is scoped to this parent thread and never follows a later ordinary turn in the child thread. Result outputStatus is available, empty, or unavailable; report unavailable explicitly and do not replay the provider turn. Empty is used only when the completed turn is known to have produced no assistant text.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpTaskStatusResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read delegated task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TaskWaitTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskWait, {
  description:
    "Wait for the delegated provider turn to finish using T3 domain events. Children announce terminal completion as durable messages in the parent thread, so prefer a short bounded wait when you need to join one instead of sitting in a long wait loop. A timeout returns current non-terminal state and never cancels the task.",
  parameters: OrchestratorMcpTaskWaitInput,
  success: OrchestratorMcpTaskWaitResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Wait for delegated task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TaskCancelTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskCancel, {
  description:
    "Cancel only the exact delegated provider turn. Repeated cancellation is safe, and a later ordinary child turn is never interrupted.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SwitchProviderTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.switchProvider, {
  description:
    "Move a delegated thread to another provider/model without losing work, for example when the current provider's limits are exhausted. This also repoints a completed delegated thread for its next child turn; completed work is not replayed. Pass the delegated thread id as taskId from the owning parent scope. An ordinary thread with a provider session can switch itself the same way by passing its own thread id as taskId from its own scope — no delegation lineage is required then, and the result carries no task. Call orchestrator_capabilities first and select only a provider with delegatable=true. The switch records a delegation.provider-switched lineage event with the old and new provider, the reason, and the carried scope (message history, pending queue, preserved lineage), repoints the thread's default provider, and replays the stored prompt on the new provider only when no turn is queued or bound yet (delegated threads only; an ordinary switch never starts a turn). Shell identity and the delegation parent never change. A cancelled delegated task cannot be switched. Fails with provider_handoff_unsupported when the target cannot accept the handoff and thread_has_no_history when there is nothing to carry.",
  parameters: OrchestratorMcpSwitchProviderInput,
  success: OrchestratorMcpSwitchProviderResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Switch thread provider")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BoardCreateCardTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.boardCreateCard, {
  description:
    "Create a kanban card owned by this Coordinator thread. The stored createdBy value remains orchestrator. The status value orchestrator is the Coordinator-owned plan-first state (alongside todo) and is the default. The card is created and a system progress-history entry is appended without an LLM call. There is no idempotency key: a repeated call creates another card.",
  parameters: OrchestratorMcpBoardCreateCardInput,
  success: OrchestratorMcpBoardCreateCardResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const BoardUpdateCardTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.boardUpdateCard, {
  description:
    "Update one card owned by this Coordinator thread. Only the calling Coordinator's cards are reachable; another Coordinator's card is reported as not found. A change to status or executor appends a system progress-history entry. Omitted fields are left unchanged. Moving a card to in_progress requires both assignee and executorThreadId (the delegated child thread); otherwise the call fails with executor_required.",
  parameters: OrchestratorMcpBoardUpdateCardInput,
  success: OrchestratorMcpBoardUpdateCardResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Update board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BoardDeleteCardTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.boardDeleteCard, {
  description:
    "Delete one card owned by this Coordinator thread. Another Coordinator's card is reported as not found. The card's progress history is deleted with it.",
  parameters: OrchestratorMcpBoardDeleteCardInput,
  success: OrchestratorMcpBoardDeleteCardResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Delete board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const BoardListCardsTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.boardListCards, {
  description:
    "List every card owned by this Coordinator thread with its append-only progress history, ordered by card order then id. Cards are never returned across Coordinator ownership.",
  parameters: OrchestratorMcpBoardListCardsInput,
  success: OrchestratorMcpBoardListCardsResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List board cards")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArchitectCreateOrGetTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.architectCreateOrGet,
  {
    description:
      "Create this coordinator thread's architect advisor, or return the existing active binding (repeat create is idempotent). The architect is a read-only advisory sibling, never an executor. Reuse the same idempotencyKey only for an exact retry.",
    parameters: OrchestratorMcpArchitectCreateOrGetInput,
    success: OrchestratorMcpArchitectCreateOrGetResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "Create or get coordinator architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArchitectReplaceTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.architectReplace, {
  description:
    "Permanently replace this coordinator thread's architect with a fresh thread id. The old binding transitions to replaced first; the old credential is then revoked. Reuse the same idempotencyKey only for an exact retry.",
  parameters: OrchestratorMcpArchitectReplaceInput,
  success: OrchestratorMcpArchitectReplaceResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Replace coordinator architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArchitectDetachTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.architectDetach, {
  description:
    "Permanently detach this coordinator thread's architect. The binding transitions to detached, the credential is revoked, and terminal bindings never restore. Reuse the same idempotencyKey only for an exact retry.",
  parameters: OrchestratorMcpArchitectDetachInput,
  success: OrchestratorMcpArchitectDetachResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Detach coordinator architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArchitectureReviewRequestTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.architectureReviewRequest,
  {
    description:
      "Request an architecture review from the bound architect. executionPosture is required on every request (continue, pause-branch, or pause-all) and is advisory only. The request wakes the architect once; the coordinator is never woken by a request. Reuse the same idempotencyKey only for an exact retry.",
    parameters: OrchestratorMcpReviewRequestInput,
    success: OrchestratorMcpReviewRequestResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "Request architecture review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArchitectureReviewAnswerTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.architectureReviewAnswer,
  {
    description:
      "Answer an architecture review as the bound architect. disposition is required (recommendation, needs-human-decision, or needs-more-evidence). Answers are first-wins and never wake the coordinator; only an explicit publish_to_coordinator wakes it. Reuse the same idempotencyKey only for an exact retry.",
    parameters: OrchestratorMcpReviewAnswerInput,
    success: OrchestratorMcpReviewAnswerResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "Answer architecture review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArchitectureReviewCancelTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.architectureReviewCancel,
  {
    description:
      "Cancel an open or answered architecture review as the coordinator (or a human on it). Cancelling a published review is rejected. Cancellation never wakes anyone. Reuse the same idempotencyKey only for an exact retry.",
    parameters: OrchestratorMcpReviewCancelInput,
    success: OrchestratorMcpReviewCancelResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "Cancel architecture review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PublishToCoordinatorTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.publishToCoordinator,
  {
    description:
      "Publish an answered review to the coordinator. This is the only architect-originated coordinator wake: it fires exactly once per review and carries the stored disposition. Ordinary answers never wake the coordinator. Reuse the same idempotencyKey only for an exact retry.",
    parameters: OrchestratorMcpPublishToCoordinatorInput,
    success: OrchestratorMcpPublishToCoordinatorResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "Publish review to coordinator")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const GetCoordinatorBindingTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.getCoordinatorBinding,
  {
    description:
      "Read the active architect binding for a coordinator thread. Visible to the coordinator itself, a human on it, or the bound architect (own binding only).",
    parameters: OrchestratorMcpGetCoordinatorBindingInput,
    success: OrchestratorMcpGetCoordinatorBindingResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "Get coordinator binding")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ListArchitectureReviewsTool = Tool.make(
  ORCHESTRATOR_MCP_TOOL_NAMES.listArchitectureReviews,
  {
    description:
      "List architecture reviews for a coordinator thread, optionally filtered by status. Visible to the coordinator itself, a human on it, or the bound architect (own reviews only).",
    parameters: OrchestratorMcpListArchitectureReviewsInput,
    success: OrchestratorMcpListArchitectureReviewsResult,
    failure: OrchestratorMcpFailure,
    dependencies,
  },
)
  .annotate(Tool.Title, "List architecture reviews")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OrchestratorMcpToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  SendToTaskTool,
  TaskListTool,
  TaskSearchTool,
  TaskReadTool,
  TaskStatusTool,
  TaskWaitTool,
  TaskCancelTool,
  SwitchProviderTool,
  BoardCreateCardTool,
  BoardUpdateCardTool,
  BoardDeleteCardTool,
  BoardListCardsTool,
  ArchitectCreateOrGetTool,
  ArchitectReplaceTool,
  ArchitectDetachTool,
  ArchitectureReviewRequestTool,
  ArchitectureReviewAnswerTool,
  ArchitectureReviewCancelTool,
  PublishToCoordinatorTool,
  GetCoordinatorBindingTool,
  ListArchitectureReviewsTool,
);
