import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATOR_MCP_TOOL_NAMES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Tool from "effect/unstable/ai/Tool";

import {
  ArchitectCreateOrGetTool,
  ArchitectDetachTool,
  ArchitectReplaceTool,
  ArchitectureReviewAnswerTool,
  ArchitectureReviewCancelTool,
  ArchitectureReviewRequestTool,
  BoardCreateCardTool,
  BoardDeleteCardTool,
  BoardListCardsTool,
  BoardUpdateCardTool,
  DelegateTaskTool,
  GetCoordinatorBindingTool,
  ListArchitectureReviewsTool,
  OrchestratorCapabilitiesTool,
  PublishToCoordinatorTool,
  SendToTaskTool,
  SwitchProviderTool,
  TaskListTool,
  TaskReadTool,
  TaskSearchTool,
  TaskCancelTool,
  TaskStatusTool,
  TaskWaitTool,
} from "./tools.ts";

describe("orchestrator MCP tools", () => {
  const tools = [
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
  ];

  it("publishes the accepted orchestrator tool surface", () => {
    expect(tools.map(({ name }) => name)).toEqual(Object.values(ORCHESTRATOR_MCP_TOOL_NAMES));
  });

  it("exposes object-shaped MCP input schemas", () => {
    for (const tool of tools) {
      expect(Tool.getJsonSchema(tool), tool.name).toMatchObject({ type: "object" });
    }
  });

  it("marks reads and mutations with accurate MCP annotations", () => {
    for (const tool of [
      OrchestratorCapabilitiesTool,
      TaskListTool,
      TaskSearchTool,
      TaskReadTool,
      TaskStatusTool,
      TaskWaitTool,
    ]) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
      expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
    }
    expect(Context.get(DelegateTaskTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(DelegateTaskTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(DelegateTaskTool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(SendToTaskTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(SendToTaskTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(SendToTaskTool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(SwitchProviderTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(SwitchProviderTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(SwitchProviderTool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(TaskCancelTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(TaskCancelTool.annotations, Tool.Destructive)).toBe(true);
    expect(Context.get(TaskCancelTool.annotations, Tool.Idempotent)).toBe(true);
  });

  it("annotates the board tools and states their ownership boundary", () => {
    expect(Context.get(BoardCreateCardTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(BoardCreateCardTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(BoardCreateCardTool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(BoardUpdateCardTool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(BoardDeleteCardTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(BoardDeleteCardTool.annotations, Tool.Destructive)).toBe(true);
    expect(Context.get(BoardDeleteCardTool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(BoardListCardsTool.annotations, Tool.Readonly)).toBe(true);
    for (const tool of [
      BoardCreateCardTool,
      BoardUpdateCardTool,
      BoardDeleteCardTool,
      BoardListCardsTool,
    ]) {
      expect(Tool.getDescription(tool), tool.name).toContain("Coordinator thread");
    }
    expect(Tool.getDescription(BoardUpdateCardTool)).toContain("reported as not found");
    expect(Tool.getDescription(BoardCreateCardTool)).toContain("The status value orchestrator");
    expect(Tool.getDescription(BoardCreateCardTool)).toContain("and is the default");
  });

  it("annotates the coordinator/architect tools with publish-only wake semantics", () => {
    for (const tool of [GetCoordinatorBindingTool, ListArchitectureReviewsTool]) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
      expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
    }
    for (const tool of [
      ArchitectCreateOrGetTool,
      ArchitectureReviewRequestTool,
      ArchitectureReviewAnswerTool,
      ArchitectureReviewCancelTool,
      PublishToCoordinatorTool,
    ]) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    }
    for (const tool of [ArchitectReplaceTool, ArchitectDetachTool]) {
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    }
    expect(Tool.getDescription(ArchitectureReviewRequestTool)).toContain("executionPosture");
    expect(Tool.getDescription(ArchitectureReviewAnswerTool)).toContain("never wake");
    expect(Tool.getDescription(PublishToCoordinatorTool)).toContain("only architect-originated");
    expect(Tool.getDescription(ArchitectDetachTool)).toContain("never restore");
  });

  it("describes inherited workspace, exact-turn isolation, and non-cancelling waits", () => {
    expect(Tool.getDescription(DelegateTaskTool)).toContain("inherited worktree");
    expect(Tool.getDescription(DelegateTaskTool)).toContain("instead of an in-process subagent");
    expect(Tool.getDescription(DelegateTaskTool)).toContain("delegatable=true");
    expect(Tool.getDescription(DelegateTaskTool)).toContain(
      "do not assume that no child work exists",
    );
    expect(Tool.getDescription(DelegateTaskTool)).toContain("same idempotencyKey");
    expect(Tool.getDescription(TaskStatusTool)).toContain("never follows a later ordinary turn");
    expect(Tool.getDescription(TaskWaitTool)).toContain("never cancels");
    expect(Tool.getDescription(TaskCancelTool)).toContain("later ordinary child turn");
    expect(Tool.getDescription(SendToTaskTool)).toContain("followUpBehavior=queue");
    expect(Tool.getDescription(SendToTaskTool)).toContain("task_status and task_cancel");
    expect(Tool.getDescription(DelegateTaskTool)).toContain(
      "durable message in this parent thread",
    );
    expect(Tool.getDescription(DelegateTaskTool)).toContain("short bounded task_wait");
    expect(Tool.getDescription(TaskWaitTool)).toContain("never cancels the task");
    expect(Tool.getDescription(TaskWaitTool)).toContain("short bounded wait");
    expect(Tool.getDescription(SwitchProviderTool)).toContain("delegatable=true");
    expect(Tool.getDescription(SwitchProviderTool)).toContain("delegation.provider-switched");
    expect(Tool.getDescription(SwitchProviderTool)).toContain("provider_handoff_unsupported");
  });
});
