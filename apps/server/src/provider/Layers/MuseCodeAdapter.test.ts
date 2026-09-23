import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { TurnOutcome } from "@muse-code/sdk";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  MUSE_LIVENESS_PROBE_METHOD,
  MUSE_LIVENESS_PROBE_TIMEOUT_MS,
  MUSE_MAX_PROGRESS_PROBE_FAILURES,
  MUSE_MAX_CONSECUTIVE_RESPAWNS,
  MUSE_TURN_SILENCE_TIMEOUT_MS,
  awaitMuseHostStall,
  awaitMuseTurn,
  makeMuseTurnIdleWatchdog,
  museApprovalModeForRuntimeMode,
  museChoiceForDecision,
  museEffortForSelection,
  museHostLivenessProbe,
  museTurnProgressProbe,
  museRespawnDecision,
  museStallOutcome,
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

describe("museRespawnDecision", () => {
  it("allows a respawn up to the cap, then reports the provider unhealthy", () => {
    expect(museRespawnDecision(0)).toEqual({ respawn: true, unhealthy: false });
    expect(museRespawnDecision(MUSE_MAX_CONSECUTIVE_RESPAWNS - 1)).toEqual({
      respawn: true,
      unhealthy: false,
    });
    expect(museRespawnDecision(MUSE_MAX_CONSECUTIVE_RESPAWNS)).toEqual({
      respawn: false,
      unhealthy: true,
    });
    expect(museRespawnDecision(MUSE_MAX_CONSECUTIVE_RESPAWNS + 4)).toEqual({
      respawn: false,
      unhealthy: true,
    });
  });
});

describe("museStallOutcome", () => {
  it("names the stall without replaying the turn when the host will be respawned", () => {
    const outcome = museStallOutcome({ dedicated: true, respawn: true, priorRespawns: 0 });
    expect(outcome.stopReason).toBe("Muse host stalled.");
    expect(outcome.unhealthy).toBe(false);
    expect(outcome.detail).toContain("without replaying the turn");
  });

  it("surfaces provider-unhealthy once the respawn cap is reached", () => {
    const outcome = museStallOutcome({ dedicated: true, respawn: false, priorRespawns: 3 });
    expect(outcome.stopReason).toBe("Muse host stalled (provider unhealthy).");
    expect(outcome.unhealthy).toBe(true);
    expect(outcome.detail).toContain("provider unhealthy");
  });

  it("keeps the stall reason when a shared host cannot be restarted", () => {
    const outcome = museStallOutcome({ dedicated: false, respawn: true, priorRespawns: 0 });
    expect(outcome.stopReason).toBe("Muse host stalled.");
    expect(outcome.unhealthy).toBe(false);
    expect(outcome.detail).toContain("shared");
  });
});

describe("museHostLivenessProbe", () => {
  it.effect("treats an answered probe as alive", () =>
    Effect.gen(function* () {
      const methods: Array<string> = [];
      const alive = yield* museHostLivenessProbe({
        connection: {
          command: (method) => {
            methods.push(method);
            return Promise.resolve({ ok: true });
          },
        },
      });
      expect(alive).toBe(true);
      expect(methods).toEqual([MUSE_LIVENESS_PROBE_METHOD]);
    }),
  );

  it.effect("treats a rejected probe as alive: the host still answered", () =>
    Effect.gen(function* () {
      const alive = yield* museHostLivenessProbe({
        connection: { command: () => Promise.reject(new Error("unsupported method")) },
      });
      expect(alive).toBe(true);
    }),
  );

  it.effect("reports an unanswered probe as unresponsive after the deadline", () =>
    Effect.gen(function* () {
      const fiber = yield* museHostLivenessProbe({
        connection: { command: () => new Promise<never>(() => {}) },
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(MUSE_LIVENESS_PROBE_TIMEOUT_MS - 1));
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.millis(1));
      expect(fiber.pollUnsafe()).toBeDefined();
    }),
  );
});

describe("awaitMuseHostStall", () => {
  it.effect("does not settle while a long-running host keeps answering the probe", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(MUSE_TURN_SILENCE_TIMEOUT_MS);
      const fiber = yield* awaitMuseHostStall({
        watchdog,
        probeHostLiveness: Effect.succeed(true),
        probeTurnProgress: Effect.succeed({ kind: "active" }),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(MUSE_TURN_SILENCE_TIMEOUT_MS * 6));
      expect(fiber.pollUnsafe()).toBeUndefined();
    }),
  );

  it.effect("settles once the silence window elapses with an unanswered probe", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(MUSE_TURN_SILENCE_TIMEOUT_MS);
      const fiber = yield* awaitMuseHostStall({
        watchdog,
        probeHostLiveness: Effect.succeed(false),
        probeTurnProgress: Effect.never,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(MUSE_TURN_SILENCE_TIMEOUT_MS - 1));
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.millis(1));
      expect(fiber.pollUnsafe()).toBeDefined();
    }),
  );

  it.effect("reconciles a completed turn while the host continues answering", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(MUSE_TURN_SILENCE_TIMEOUT_MS);
      const terminal = { kind: "terminalUnknown" } as TurnOutcome;
      const fiber = yield* awaitMuseHostStall({
        watchdog,
        probeHostLiveness: Effect.succeed(true),
        probeTurnProgress: Effect.succeed({ kind: "reconciled", terminal }),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(MUSE_TURN_SILENCE_TIMEOUT_MS));
      expect(fiber.pollUnsafe()).toMatchObject({ _tag: "Success", value: { kind: "reconciled" } });
    }),
  );

  it.effect("settles unknown progress after bounded failed reads", () =>
    Effect.gen(function* () {
      const watchdog = yield* makeMuseTurnIdleWatchdog(MUSE_TURN_SILENCE_TIMEOUT_MS);
      const fiber = yield* awaitMuseHostStall({
        watchdog,
        probeHostLiveness: Effect.succeed(true),
        probeTurnProgress: Effect.succeed({ kind: "unavailable" }),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(
        Duration.millis(MUSE_TURN_SILENCE_TIMEOUT_MS * MUSE_MAX_PROGRESS_PROBE_FAILURES),
      );
      expect(fiber.pollUnsafe()).toMatchObject({ _tag: "Success", value: { kind: "unknown" } });
    }),
  );
});

describe("museTurnProgressProbe", () => {
  it.effect("recovers only the matching durable turn terminal", () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const progress = yield* museTurnProgressProbe(
        {
          connection: {
            request(method) {
              methods.push(method);
              return Promise.resolve(
                method === "session/read"
                  ? { session: { sessionId: "session-1", activeTurnId: null } }
                  : {
                      events: [
                        {
                          method: "turn/completed",
                          params: {
                            sessionId: "session-1",
                            turnId: "other-turn",
                            terminal: "completed",
                            sourceRange: {},
                          },
                        },
                        {
                          method: "turn/completed",
                          params: {
                            sessionId: "session-1",
                            turnId: "turn-1",
                            terminal: "completed",
                            sourceRange: {},
                          },
                        },
                      ],
                      nextCursor: null,
                    },
              );
            },
          },
        },
        "session-1",
        "turn-1",
      );
      expect(progress).toMatchObject({
        kind: "reconciled",
        terminal: { kind: "completed", params: { turnId: "turn-1" } },
      });
      expect(methods).toEqual(["session/read", "view/page"]);
    }),
  );

  it.effect("keeps an active tool running without paging", () =>
    Effect.gen(function* () {
      const progress = yield* museTurnProgressProbe(
        {
          connection: {
            request: (method) => {
              expect(method).toBe("session/read");
              return Promise.resolve({
                session: { sessionId: "session-1", activeTurnId: "turn-1" },
              });
            },
          },
        },
        "session-1",
        "turn-1",
      );
      expect(progress).toEqual({ kind: "active" });
    }),
  );

  it.effect("reports an unknown outcome when durable history omits the terminal", () =>
    Effect.gen(function* () {
      const progress = yield* museTurnProgressProbe(
        {
          connection: {
            request: (method) =>
              Promise.resolve(
                method === "session/read"
                  ? { session: { sessionId: "session-1", activeTurnId: null } }
                  : { events: [], nextCursor: null },
              ),
          },
        },
        "session-1",
        "turn-1",
      );
      expect(progress).toMatchObject({ kind: "unknown" });
    }),
  );
});

describe("awaitMuseTurn", () => {
  it.effect("returns the host terminal when the turn completes", () =>
    Effect.gen(function* () {
      const outcome = yield* awaitMuseTurn({
        drainDeltas: Effect.void,
        awaitTerminal: Effect.succeed({ kind: "terminalUnknown" } as TurnOutcome),
        awaitStall: Effect.never,
      });
      expect(outcome.source).toBe("terminal");
    }),
  );

  it.effect("settles a failed delta stream instead of waiting forever", () =>
    Effect.gen(function* () {
      const outcome = yield* awaitMuseTurn({
        drainDeltas: Effect.fail(
          new ProviderAdapterRequestError({
            provider: "museCode",
            method: "item/delta",
            detail: "stream broke",
          }),
        ),
        awaitTerminal: Effect.never,
        awaitStall: Effect.never,
      });
      expect(outcome.source).toBe("streamFailed");
    }),
  );

  it.effect("prefers the host-stall outcome over a hanging stream", () =>
    Effect.gen(function* () {
      const outcome = yield* awaitMuseTurn({
        drainDeltas: Effect.never,
        awaitTerminal: Effect.never,
        awaitStall: Effect.succeed("stalled"),
      });
      expect(outcome.source).toBe("stalled");
    }),
  );

  it.effect("returns a durable terminal when SDK streams remain pending", () =>
    Effect.gen(function* () {
      const terminal = { kind: "terminalUnknown" } as TurnOutcome;
      const outcome = yield* awaitMuseTurn({
        drainDeltas: Effect.never,
        awaitTerminal: Effect.never,
        awaitStall: Effect.succeed({ kind: "reconciled", terminal }),
      });
      expect(outcome).toEqual({ source: "reconciled", terminal });
    }),
  );
});
