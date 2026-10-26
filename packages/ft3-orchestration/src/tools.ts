import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as TaskQueryService from "./TaskQueryService.ts";
import * as Contracts from "./contracts.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, TaskQueryService.TaskQueryService];

const taskList = Tool.make("task_list", {
  description:
    "List this parent's direct T3-owned delegated tasks, including archived children. taskId is the V2 task node ID used by task_status; role and summary are unavailable and null.",
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

export const toolkit = Toolkit.make(taskList, taskSearch, taskRead);
