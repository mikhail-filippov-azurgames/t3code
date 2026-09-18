import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  STEER_TERMINAL_TIMEOUT,
  STEER_UNSUPPORTED,
  applyTurnSettled,
  applyTurnStarted,
  initialFollowUpTurnState,
  isTurnSettled,
  makeTurnTerminalWatcher,
  resolveFollowUpAction,
} from "./FollowUpBehavior.ts";

describe("resolveFollowUpAction", () => {
  it("starts plainly when no turn is active, whatever the requested behavior", () => {
    expect(resolveFollowUpAction({ supportsSteer: true })).toEqual({ action: "start" });
    expect(resolveFollowUpAction({ followUpBehavior: "queue", supportsSteer: true })).toEqual({
      action: "start",
    });
    expect(resolveFollowUpAction({ followUpBehavior: "steer", supportsSteer: true })).toEqual({
      action: "start",
    });
  });

  it("treats a blank active turn id as no active turn", () => {
    expect(
      resolveFollowUpAction({
        followUpBehavior: "steer",
        activeTurnId: "   ",
        supportsSteer: true,
      }),
    ).toEqual({ action: "start" });
  });

  it("queues onto the active turn by default and on explicit queue", () => {
    expect(resolveFollowUpAction({ activeTurnId: "turn-1", supportsSteer: true })).toEqual({
      action: "queue",
    });
    expect(
      resolveFollowUpAction({
        followUpBehavior: "queue",
        activeTurnId: "turn-1",
        supportsSteer: true,
      }),
    ).toEqual({ action: "queue" });
  });

  it("steers the active turn and names the superseded id", () => {
    expect(
      resolveFollowUpAction({
        followUpBehavior: "steer",
        activeTurnId: "turn-1",
        supportsSteer: true,
      }),
    ).toEqual({ action: "steer", supersededTurnId: "turn-1" });
  });

  it("rejects steer with a failure code when the runtime cannot interrupt", () => {
    expect(
      resolveFollowUpAction({
        followUpBehavior: "steer",
        activeTurnId: "turn-1",
        supportsSteer: false,
      }),
    ).toEqual({
      action: "reject",
      code: STEER_UNSUPPORTED,
      message:
        "Steer of turn 'turn-1' is not supported by this provider: interrupting the active turn is unavailable.",
    });
  });
});

describe("follow-up turn state", () => {
  it("starts a turn as active and keeps lineage without duplicates", () => {
    const started = applyTurnStarted(initialFollowUpTurnState(), "turn-1");
    expect(started.activeTurnId).toBe("turn-1");
    expect(started.turnIds).toEqual(["turn-1"]);
    expect(isTurnSettled(started, "turn-1")).toBe(false);
    const restarted = applyTurnStarted(started, "turn-1");
    expect(restarted.turnIds).toEqual(["turn-1"]);
  });

  it("settling the active turn clears the slot and marks it settled", () => {
    const settled = applyTurnSettled(
      applyTurnStarted(initialFollowUpTurnState(), "turn-1"),
      "turn-1",
    );
    expect(settled.activeTurnId).toBeUndefined();
    expect(isTurnSettled(settled, "turn-1")).toBe(true);
    // Settling twice stays put.
    expect(applyTurnSettled(settled, "turn-1")).toEqual(settled);
  });

  it("settling a superseded turn keeps the new turn active instead of hanging it", () => {
    // Steer: turn-2 starts while turn-1 is still in flight.
    const steered = applyTurnStarted(
      applyTurnStarted(initialFollowUpTurnState(), "turn-1"),
      "turn-2",
    );
    expect(steered.activeTurnId).toBe("turn-2");
    // Turn-1's terminal lands late: it settles turn-1…
    const settled = applyTurnSettled(steered, "turn-1");
    expect(isTurnSettled(settled, "turn-1")).toBe(true);
    // …without clearing (or stranding) the new active turn.
    expect(settled.activeTurnId).toBe("turn-2");
    expect(settled.turnIds).toEqual(["turn-1", "turn-2"]);
  });

  it("exposes a bounded steer terminal wait", () => {
    expect(STEER_TERMINAL_TIMEOUT).toBe("10 seconds");
  });
});

describe("makeTurnTerminalWatcher", () => {
  it.effect("resolves a pending await once the terminal is noted", () =>
    Effect.gen(function* () {
      const watcher = yield* makeTurnTerminalWatcher;
      const waiting = yield* watcher.awaitTerminal("turn-1").pipe(Effect.forkChild);
      // Still pending: no terminal has been noted, and nothing else can
      // settle a gate keyed by this turn id.
      yield* Effect.sync(() => {
        expect(waiting.pollUnsafe()).toBeUndefined();
      });
      yield* watcher.noteTerminal("turn-1");
      yield* Fiber.join(waiting);
      // A repeated note is idempotent, not a defect.
      yield* watcher.noteTerminal("turn-1");
      yield* watcher.awaitTerminal("turn-1");
    }),
  );

  it.effect("keeps unrelated turns on their own gate", () =>
    Effect.gen(function* () {
      const watcher = yield* makeTurnTerminalWatcher;
      yield* watcher.noteTerminal("turn-1");
      // The noted terminal resolves without anyone waiting first.
      yield* watcher.awaitTerminal("turn-1");
      // A turn with no terminal stays pending until its own note lands.
      const other = yield* watcher.awaitTerminal("turn-2").pipe(Effect.forkChild);
      yield* Effect.sync(() => {
        expect(other.pollUnsafe()).toBeUndefined();
      });
      yield* Fiber.interrupt(other);
    }),
  );
});
