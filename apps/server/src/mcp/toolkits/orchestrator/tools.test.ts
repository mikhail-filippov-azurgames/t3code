import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATOR_MCP_TOOL_NAMES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Tool from "effect/unstable/ai/Tool";

import {
  DelegateTaskTool,
  OrchestratorCapabilitiesTool,
  TaskCancelTool,
  TaskStatusTool,
  TaskWaitTool,
} from "./tools.ts";

describe("orchestrator MCP tools", () => {
  const tools = [
    OrchestratorCapabilitiesTool,
    DelegateTaskTool,
    TaskStatusTool,
    TaskWaitTool,
    TaskCancelTool,
  ];

  it("publishes exactly the accepted five-tool surface", () => {
    expect(tools.map(({ name }) => name)).toEqual(Object.values(ORCHESTRATOR_MCP_TOOL_NAMES));
  });

  it("exposes object-shaped MCP input schemas", () => {
    for (const tool of tools) {
      expect(Tool.getJsonSchema(tool), tool.name).toMatchObject({ type: "object" });
    }
  });

  it("marks reads and mutations with accurate MCP annotations", () => {
    for (const tool of [OrchestratorCapabilitiesTool, TaskStatusTool, TaskWaitTool]) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
      expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
    }
    expect(Context.get(DelegateTaskTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(DelegateTaskTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(DelegateTaskTool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(TaskCancelTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(TaskCancelTool.annotations, Tool.Destructive)).toBe(true);
    expect(Context.get(TaskCancelTool.annotations, Tool.Idempotent)).toBe(true);
  });

  it("describes inherited workspace, exact-turn isolation, and non-cancelling waits", () => {
    expect(Tool.getDescription(DelegateTaskTool)).toContain("inherited worktree");
    expect(Tool.getDescription(TaskStatusTool)).toContain("never follows a later ordinary turn");
    expect(Tool.getDescription(TaskWaitTool)).toContain("never cancels");
    expect(Tool.getDescription(TaskCancelTool)).toContain("later ordinary child turn");
  });
});
