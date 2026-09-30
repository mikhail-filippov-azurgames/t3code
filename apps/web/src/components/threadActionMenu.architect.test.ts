import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { buildCoordinatorArchitectSidebarPrompt } from "./threadActionMenu.logic";

describe("coordinator Architect sidebar prompts", () => {
  it("carries the picked route into a policy-checked replace request", () => {
    const prompt = buildCoordinatorArchitectSidebarPrompt({
      action: "replace",
      architectThreadId: ThreadId.make("arch:binding-1"),
      taskEffort: "very-high",
      questionOrReason: "The current provider is unavailable.",
      preferredTarget: {
        instanceId: "codex",
        driverKind: "codex",
        model: "gpt-6-luna",
      },
    });
    expect(prompt).toContain("architect_replace");
    expect(prompt).toContain("gpt-6-luna");
    expect(prompt).toContain("role=architecture");
    expect(prompt).toContain(
      "Accepted policy: oc://doc/3900df61-9dd5-4621-9278-34ac20d60648 (its current accepted revision is authoritative; read it from OpenContext)",
    );
  });

  it("states detach retention and ordered revocation", () => {
    const prompt = buildCoordinatorArchitectSidebarPrompt({
      action: "detach",
      architectThreadId: ThreadId.make("arch:binding-1"),
      taskEffort: "high",
      questionOrReason: "No longer needed.",
    });
    expect(prompt).toContain("architect_detach");
    expect(prompt).toContain("retains the binding");
    expect(prompt).toContain("after the durable transition");
  });
});
