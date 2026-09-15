import {
  ORCHESTRATOR_MCP_TOOL_NAMES,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
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
    "Create one ordinary child T3 Code thread in this thread's project and inherited worktree, then start exactly one provider turn using the selected provider/model. Use this instead of an in-process subagent when the user asks for a new or separate T3 thread. Call orchestrator_capabilities first and select only a provider with delegatable=true. An optional OCL handoff is stored in durable lineage and is not appended to the child message; put every child-facing instruction in prompt. Reuse the same idempotencyKey only for an exact retry. A typed pre-spawn validation failure creates no child. For any other failure without a taskId, do not assume that no child work exists: retry the exact request with the same idempotencyKey to recover its deterministic task.",
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
    "Wait for the delegated provider turn to finish using T3 domain events. A timeout returns current non-terminal state and never cancels the task.",
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

export const OrchestratorMcpToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskWaitTool,
  TaskCancelTool,
);
