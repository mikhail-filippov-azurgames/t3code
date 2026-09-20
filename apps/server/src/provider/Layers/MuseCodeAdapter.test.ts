import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  makeMuseTurnIdleWatchdog,
  museApprovalModeForRuntimeMode,
  museChoiceForDecision,
  museEffortForSelection,
  mspErrorText,
  museItemLifecycle,
  museNeedsElevatedHost,
  musePlanStepsFromTodos,
  parseMuseEffort,
  shouldFoldDelta,
} from "./MuseCodeAdapter.ts";

describe("museApprovalModeForRuntimeMode", () => {
  it("maps every thread runtime mode onto an MSP approval mode", () => {
    expect(museApprovalModeForRuntimeMode("full-access")).toBe("allowAll");
    expect(museApprovalModeForRuntimeMode("auto")).toBe("promptUnmatched");
    expect(museApprovalModeForRuntimeMode("auto-accept-edits")).toBe("promptUnmatched");
    expect(museApprovalModeForRuntimeMode("approval-required")).toBe("onRequest");
  });

  it("leaves the host default when the mode is absent", () => {
    expect(museApprovalModeForRuntimeMode(undefined)).toBeUndefined();
  });
});

describe("musePlanStepsFromTodos", () => {
  it("maps todo statuses onto plan steps and prefers the active form", () => {
    expect(
      musePlanStepsFromTodos([
        { text: "Done", status: "completed" },
        { text: "Read files", status: "inProgress", activeForm: "Reading files" },
        { text: "Later", status: "pending" },
      ]),
    ).toEqual([
      { step: "Done", status: "completed" },
      { step: "Reading files", status: "inProgress" },
      { step: "Later", status: "pending" },
    ]);
  });

  it("treats cancelled todos as done and drops blank or unknown entries", () => {
    expect(
      musePlanStepsFromTodos([
        { text: "Dropped", status: "cancelled" },
        { text: "   ", status: "pending" },
        { text: "Weird", status: "stale" },
      ]),
    ).toEqual([
      { step: "Dropped", status: "completed" },
      { step: "Weird", status: "pending" },
    ]);
    expect(musePlanStepsFromTodos([])).toEqual([]);
  });
});

describe("museItemLifecycle", () => {
  it("maps tool calls onto foldable dynamic tool cards", () => {
    expect(museItemLifecycle({ kind: "toolCall", tool: "read" }, "item.started")).toEqual({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "read",
    });
    expect(
      museItemLifecycle(
        { kind: "toolCall", tool: "read", visibleOutput: "42 lines", status: "completed" },
        "item.completed",
      ),
    ).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "read",
      detail: "42 lines",
    });
    expect(
      museItemLifecycle({ kind: "toolCall", tool: "exec", status: "failed" }, "item.completed"),
    ).toEqual({
      itemType: "dynamic_tool_call",
      status: "failed",
      title: "exec",
    });
  });

  it("maps shell items onto command execution cards", () => {
    expect(museItemLifecycle({ kind: "userShell", commandText: "rg foo" }, "item.started")).toEqual(
      {
        itemType: "command_execution",
        status: "inProgress",
        title: "Ran command",
        detail: "rg foo",
      },
    );
    expect(
      museItemLifecycle(
        { kind: "userShell", commandText: "rg foo", visibleOutput: "3 hits", status: "done" },
        "item.completed",
      ),
    ).toEqual({
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
      detail: "3 hits",
    });
  });

  it("leaves chat kinds without tool cards", () => {
    expect(museItemLifecycle({ kind: "reasoning" }, "item.started")).toBeUndefined();
    expect(museItemLifecycle({ kind: "agentMessage" }, "item.completed")).toBeUndefined();
    expect(museItemLifecycle({ kind: "toolCall", tool: "  " }, "item.started")).toBeUndefined();
    expect(museItemLifecycle({ kind: "workflow" }, "item.completed")).toBeUndefined();
  });
});

describe("mspErrorText", () => {
  it("renders plain-object rejections instead of [object Object]", () => {
    expect(mspErrorText(new Error("boom"))).toBe("boom");
    expect(mspErrorText("plain")).toBe("plain");
    expect(mspErrorText({ code: -32000, message: "no run" })).toBe(
      '{"code":-32000,"message":"no run"}',
    );
  });
});

describe("shouldFoldDelta", () => {
  it("folds only tool output already covered by a card", () => {
    expect(shouldFoldDelta("output", true)).toBe(true);
    expect(shouldFoldDelta("output", false)).toBe(false);
    expect(shouldFoldDelta("text", true)).toBe(false);
    expect(shouldFoldDelta("reason", true)).toBe(false);
    expect(shouldFoldDelta(undefined, true)).toBe(false);
  });
});

describe("museNeedsElevatedHost", () => {
  it("routes full-access onto the sandbox-disabled trusted host", () => {
    expect(museNeedsElevatedHost("full-access")).toBe(true);
  });

  it("keeps restricted modes and the absent mode on the default host", () => {
    expect(museNeedsElevatedHost("auto")).toBe(false);
    expect(museNeedsElevatedHost("auto-accept-edits")).toBe(false);
    expect(museNeedsElevatedHost("approval-required")).toBe(false);
    expect(museNeedsElevatedHost(undefined)).toBe(false);
  });
});

describe("parseMuseEffort", () => {
  it("accepts the offered tiers and stays empty when absent", () => {
    expect(parseMuseEffort(undefined)).toBeUndefined();
    expect(parseMuseEffort("high")).toBe("high");
    expect(parseMuseEffort("xhigh")).toBe("xhigh");
  });

  it("rejects tiers outside the offered set", () => {
    expect(parseMuseEffort("ultra")).toBeUndefined();
    expect(parseMuseEffort("")).toBeUndefined();
  });
});

describe("museEffortForSelection", () => {
  it("reads the reasoningEffort option", () => {
    const selection = createModelSelection(ProviderInstanceId.make("museCode"), "muse-spark-1.3", [
      { id: "reasoningEffort", value: "low" },
    ]);

    expect(museEffortForSelection(selection)).toEqual({ raw: "low", effort: "low" });
  });

  it("reports unknown values for explicit rejection", () => {
    const selection = createModelSelection(ProviderInstanceId.make("museCode"), "muse-spark-1.3", [
      { id: "reasoningEffort", value: "ultra" },
    ]);

    expect(museEffortForSelection(selection)).toEqual({ raw: "ultra", effort: undefined });
    expect(museEffortForSelection(undefined)).toEqual({ raw: undefined, effort: undefined });
  });
});

const CHOICES = [
  { choiceId: "approve", decision: "approved", scope: "once" },
  { choiceId: "approve-session", decision: "approvedForSession", scope: "session" },
  { choiceId: "deny", decision: "denied", scope: "once" },
] as const;

describe("museChoiceForDecision", () => {
  it("maps accept onto the one-shot approval", () => {
    expect(museChoiceForDecision("accept", [...CHOICES])).toBe("approve");
  });

  it("maps acceptForSession onto the session approval", () => {
    expect(museChoiceForDecision("acceptForSession", [...CHOICES])).toBe("approve-session");
  });

  it("maps decline onto the denial", () => {
    expect(museChoiceForDecision("decline", [...CHOICES])).toBe("deny");
  });

  it("maps cancel onto abort when offered, denial otherwise", () => {
    expect(
      museChoiceForDecision("cancel", [
        ...CHOICES,
        { choiceId: "abort", decision: "abort", scope: "once" },
      ]),
    ).toBe("abort");
    expect(museChoiceForDecision("cancel", [...CHOICES])).toBe("deny");
  });

  it("returns undefined when nothing matches", () => {
    expect(museChoiceForDecision("accept", [])).toBeUndefined();
    expect(
      museChoiceForDecision("accept", [{ choiceId: "deny", decision: "denied", scope: "once" }]),
    ).toBeUndefined();
  });
});

describe("makeMuseTurnIdleWatchdog", () => {
  it.effect("resolves only after an idle window with no activity", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(1000);
      const fiber = yield* watchdog.awaitIdle.pipe(Effect.forkChild);
      yield* TestClock.adjust("999 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(fiber.pollUnsafe()).toBeDefined();
    }),
  );

  it.effect("restarts its deadline every time activity arrives", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(1000);
      const fiber = yield* watchdog.awaitIdle.pipe(Effect.forkChild);
      yield* TestClock.adjust("800 millis");
      yield* watchdog.markActivity;
      yield* TestClock.adjust("800 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("200 millis");
      expect(fiber.pollUnsafe()).toBeDefined();
    }),
  );

  it.effect("never resolves while activity keeps arriving", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(1000);
      const fiber = yield* watchdog.awaitIdle.pipe(Effect.forkChild);
      for (let index = 0; index < 5; index += 1) {
        yield* TestClock.adjust("500 millis");
        yield* watchdog.markActivity;
      }
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1000 millis");
      expect(fiber.pollUnsafe()).toBeDefined();
    }),
  );
});
