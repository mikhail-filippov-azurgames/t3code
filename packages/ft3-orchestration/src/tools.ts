import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as TaskHandoffService from "./TaskHandoffService.ts";
import * as TaskQueryService from "./TaskQueryService.ts";
import * as Contracts from "./contracts.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  TaskQueryService.TaskQueryService,
  TaskHandoffService.TaskHandoffService,
];

const taskList = Tool.make("task_list", {
  description:
    "List this parent's direct T3-owned delegated tasks, including archived children. taskId is the V2 task node ID used by task_status; role is unavailable and null, and summary carries the latest delegated-turn summary once it exists.",
  parameters: Contracts.TaskListInput,
  success: Contracts.TaskListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const taskSearch = Tool.make("task_search", {
  description:
    "Search this parent's direct T3-owned tasks by task, child thread or provider turn ID, status, worktree path, title or published result. Each page scans at most 500 candidates; follow nextCursor even for an empty page.",
  parameters: Contracts.TaskSearchInput,
  success: Contracts.TaskSearchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const taskRead = Tool.make("task_read", {
  description:
    "Read a page of transcript for a direct T3-owned task of this parent, including archived children. Pass the returned beforeCursor to read older items. V2 row and byte limits can split a turn; activities carry V2 timeline items.",
  parameters: Contracts.TaskReadInput,
  success: Contracts.TaskReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const taskSummaryHistory = Tool.make("task_summary_history", {
  description:
    "Page through this parent's delegated-turn summaries, newest first, including imported historical summaries. stale marks records that no longer describe the child's current turn; follow nextCursor to read older records.",
  parameters: Contracts.TaskSummaryHistoryInput,
  success: Contracts.TaskSummaryHistoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const taskAttachHandoff = Tool.make("task_attach_handoff", {
  description:
    "Attach an OCL handoff to one of this parent's direct T3-owned delegated tasks after delegate_task. Only the task's parent may attach, and repeating the same handoff is idempotent.",
  parameters: Contracts.TaskAttachHandoffInput,
  success: Contracts.TaskAttachHandoffResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const toolkit = Toolkit.make(
  taskList,
  taskSearch,
  taskRead,
  taskSummaryHistory,
  taskAttachHandoff,
);
