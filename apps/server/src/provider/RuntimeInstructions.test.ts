import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("describes durable delegation only when orchestration is available", () => {
    const enabled = buildRuntimeInstructions({
      harness: "Codex",
      orchestrationAvailable: true,
    });
    const disabled = buildRuntimeInstructions({ harness: "Codex" });

    expect(enabled).toContain("durable cross-provider child threads");
    expect(enabled).toContain("call orchestrator_capabilities");
    expect(enabled).toContain("For small single-owner tasks, work directly");
    expect(disabled).not.toContain("<orchestration>");
    expect(disabled).not.toContain("orchestrator_capabilities");
  });

  it("teaches the parent_not_active reason token instead of guesswork", () => {
    const enabled = buildRuntimeInstructions({
      harness: "Muse",
      orchestrationAvailable: true,
    });
    expect(enabled).toContain("[reason=...]");
    expect(enabled).toContain("parent_turn_mismatch");
    expect(enabled).toContain("parent_session_instance_changed");
    expect(enabled).toContain("never invent an explanation");
  });
});
