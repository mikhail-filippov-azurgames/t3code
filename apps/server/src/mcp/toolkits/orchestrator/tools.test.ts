import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATOR_MCP_TOOL_NAMES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Tool from "effect/unstable/ai/Tool";

import {
  DelegateTaskTool,
  OrchestratorCapabilitiesTool,
  SwitchProviderTool,
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
    SwitchProviderTool,
  ];

  it("publishes exactly the accepted six-tool surface", () => {
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
    expect(Context.get(SwitchProviderTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(SwitchProviderTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(SwitchProviderTool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(TaskCancelTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(TaskCancelTool.annotations, Tool.Destructive)).toBe(true);
    expect(Context.get(TaskCancelTool.annotations, Tool.Idempotent)).toBe(true);
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
