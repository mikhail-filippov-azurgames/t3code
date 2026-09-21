import {
  ORCHESTRATOR_MCP_TOOL_NAMES,
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
  OrchestratorMcpSwitchProviderInput,
  OrchestratorMcpSwitchProviderResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
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

export const TaskStatusTool = Tool.make(ORCHESTRATOR_MCP_TOOL_NAMES.taskStatus, {
  description:
    "Read the delegated task's exact provider-turn state and result. The lookup is scoped to this parent thread and never follows a later ordinary turn in the child thread.",
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
    "Create a kanban card owned by this orchestrator thread. createdBy is always orchestrator. status is todo or orchestrator and defaults to orchestrator (plan-first). The card is created and a system progress-history entry is appended without an LLM call. There is no idempotency key: a repeated call creates another card.",
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
    "Update one card owned by this orchestrator thread. Only the calling orchestrator's cards are reachable; another orchestrator's card is reported as not found. A change to status or executor appends a system progress-history entry. Omitted fields are left unchanged. Moving a card to in_progress requires both assignee and executorThreadId (the delegated child thread); otherwise the call fails with executor_required.",
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
    "Delete one card owned by this orchestrator thread. Another orchestrator's card is reported as not found. The card's progress history is deleted with it.",
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
    "List every card owned by this orchestrator thread with its append-only progress history, ordered by card order then id. Cards are never returned across orchestrator ownership.",
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

export const OrchestratorMcpToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskWaitTool,
  TaskCancelTool,
  SwitchProviderTool,
  BoardCreateCardTool,
  BoardUpdateCardTool,
  BoardDeleteCardTool,
  BoardListCardsTool,
);
