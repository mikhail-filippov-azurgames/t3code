import { assert, describe, it } from "@effect/vitest";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { docsBriefBlock, setDocumentsBriefEnabled } from "@t3tools/ft3-docs/brief";
import * as Effect from "effect/Effect";

import { applyNativeSubagentGuidance, delegatedTaskPrompt } from "./delegationRoles.ts";

describe("ft3 delegation roles", () => {
  it("leaves the prompt untouched while roles are off", () => {
    const upstreamPrompt = "Act as the review sub-agent for this task.\n\nReview it.";
    assert.equal(
      delegatedTaskPrompt({ roleLine: "", task: "Review it.", upstreamPrompt }),
      upstreamPrompt,
    );
  });

  it("puts the applied role line before the task while roles are on", () => {
    const roleLine = "Your role is review-common. Follow this role instruction before any work.";
    const prompt = delegatedTaskPrompt({
      roleLine,
      task: "Check the boundaries.",
      upstreamPrompt: "Act as the review sub-agent for this task.",
    });
    assert.equal(prompt, `${roleLine}\n\nCheck the boundaries.`);
  });

  it("adds the documents brief block only while documents are effective", () => {
    const upstreamPrompt = "Act as the review sub-agent for this task.";
    try {
      setDocumentsBriefEnabled(true);
      assert.equal(
        delegatedTaskPrompt({ roleLine: "", task: "Review it.", upstreamPrompt }),
        `${docsBriefBlock()}\n\n${upstreamPrompt}`,
      );
    } finally {
      setDocumentsBriefEnabled(false);
    }
    assert.equal(
      delegatedTaskPrompt({ roleLine: "", task: "Review it.", upstreamPrompt }),
      upstreamPrompt,
    );
  });

  it.effect("drops the native-subagent guidance only while the applied roles are configured", () =>
    Effect.gen(function* () {
      yield* applyNativeSubagentGuidance(false);
      assert.include(
        t3OrchestrationSystemPrompt(true, false) ?? "",
        "- Subagents: use your native tool",
      );

      yield* applyNativeSubagentGuidance(true);
      const configured = t3OrchestrationSystemPrompt(true, false) ?? "";
      assert.notInclude(configured, "- Subagents: use your native tool");
      assert.include(configured, "`delegate_task`");

      yield* applyNativeSubagentGuidance(false);
      assert.include(
        t3OrchestrationSystemPrompt(true, false) ?? "",
        "- Subagents: use your native tool",
      );
    }),
  );
});
