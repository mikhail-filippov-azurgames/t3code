import { describe, expect, it } from "@effect/vitest";
import { MessageId, type OrchestrationThread } from "@t3tools/contracts";

import { __testing } from "./ProviderCommandReactor.ts";

const { resolveCrossDriverHandoff, shouldRecoverQueuedTurnStart } = __testing;

const currentMessageId = MessageId.make("current-prompt");
const currentMessageText = "Continue with the next implementation step.";

function message(id: string, role: "user" | "assistant" | "system", text: string) {
  return { id: MessageId.make(id), role, text };
}

function detailWith(messages: ReadonlyArray<ReturnType<typeof message>>) {
  return { messages } as unknown as OrchestrationThread;
}

describe("resolveCrossDriverHandoff", () => {
  it("needs nothing when no cross-driver restart happens", () => {
    expect(
      resolveCrossDriverHandoff({
        required: false,
        detail: undefined,
        currentMessageId,
        currentMessageText,
      }),
    ).toEqual({ kind: "not-required" });
  });

  it("fails when history is unavailable", () => {
    const resolution = resolveCrossDriverHandoff({
      required: true,
      detail: undefined,
      currentMessageId,
      currentMessageText,
    });
    expect(resolution.kind).toBe("unsupported");
    if (resolution.kind !== "unsupported") return;
    expect(resolution.reason).toContain("conversation history");
  });

  it("allows an empty history beyond the current prompt", () => {
    expect(
      resolveCrossDriverHandoff({
        required: true,
        detail: detailWith([message("current-prompt", "user", currentMessageText)]),
        currentMessageId,
        currentMessageText,
      }),
    ).toEqual({ kind: "trivial-history" });
  });

  it("ignores already-delivered wake messages when checking history", () => {
    const delivered = MessageId.make("delegation-wake:child:1");
    expect(
      resolveCrossDriverHandoff({
        required: true,
        detail: detailWith([
          { id: delivered, role: "system", text: "[Delegated child result]\nDone.\n[/Done]" },
          message("current-prompt", "user", currentMessageText),
        ]),
        currentMessageId,
        currentMessageText,
        excludedMessageIds: new Set([delivered]),
      }),
    ).toEqual({ kind: "trivial-history" });
  });

  it("carries prior history explicitly instead of sending a bare prompt", () => {
    const resolution = resolveCrossDriverHandoff({
      required: true,
      detail: detailWith([
        message("initial-prompt", "user", "Implement the accepted widget contract."),
        message("assistant-answer", "assistant", "The widget renders with virtualized rows."),
        message("current-prompt", "user", currentMessageText),
      ]),
      currentMessageId,
      currentMessageText,
    });
    expect(resolution.kind).toBe("context");
    if (resolution.kind !== "context") return;
    expect(resolution.text).toContain("The widget renders with virtualized rows.");
    expect(resolution.text).toContain(currentMessageText);
  });

  it("fails when history exists but cannot be transferred", () => {
    const resolution = resolveCrossDriverHandoff({
      required: true,
      detail: detailWith([
        message("initial-prompt", "user", "Implement the accepted widget contract."),
        message("assistant-answer", "assistant", "The widget renders with virtualized rows."),
        message("current-prompt", "user", currentMessageText),
      ]),
      currentMessageId,
      currentMessageText: "x".repeat(200_000),
    });
    expect(resolution.kind).toBe("unsupported");
  });
});

describe("shouldRecoverQueuedTurnStart", () => {
  it("recovers an unbound user prompt without a failure marker", () => {
    expect(shouldRecoverQueuedTurnStart({ role: "user", turnId: null }, false)).toBe(true);
  });

  it("never recovers a prompt already bound to a turn", () => {
    expect(shouldRecoverQueuedTurnStart({ role: "user", turnId: "turn-1" }, false)).toBe(false);
  });

  it("never recovers a prompt with a recorded start failure", () => {
    expect(shouldRecoverQueuedTurnStart({ role: "user", turnId: null }, true)).toBe(false);
  });

  it("never recovers a missing or non-user message", () => {
    expect(shouldRecoverQueuedTurnStart(undefined, false)).toBe(false);
    expect(shouldRecoverQueuedTurnStart({ role: "assistant", turnId: null }, false)).toBe(false);
  });
});
