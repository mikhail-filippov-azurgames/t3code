/**
 * FollowUpBehavior — shared mid-turn send policy for provider runtimes.
 *
 * A message sent while the provider is still answering either waits for the
 * active turn to settle (`queue`, the historical behavior everywhere) or cuts
 * in (`steer`: interrupt the active turn with its partial output preserved,
 * then start a new turn with the new message).
 *
 * The decision itself is pure so every runtime resolves it the same way; the
 * runtimes differ only in how they interrupt and what they await. Turn-state
 * transitions are pure too: a superseded turn's terminal must settle that
 * turn without clearing the new active turn, otherwise lifecycle guards drop
 * the stale terminal and the client hangs in working/thinking forever.
 *
 * @module provider/FollowUpBehavior
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { FollowUpBehavior } from "@t3tools/contracts";

/** Steer was requested but this runtime cannot interrupt-and-restart. */
export const STEER_UNSUPPORTED = "steer_unsupported" as const;
export type SteerFailureCode = typeof STEER_UNSUPPORTED;

/**
 * How long a steer waits for the superseded turn's terminal before starting
 * the new turn anyway (with a synthetic terminal, so the old turn still
 * settles). A wedged host must not hang the new turn forever.
 */
export const STEER_TERMINAL_TIMEOUT = "10 seconds" as const;

export type FollowUpAction =
  /** No active turn: plain start, whatever the requested behavior. */
  | { readonly action: "start" }
  /** Active turn in queue mode: the historical overlapping/queued start. */
  | { readonly action: "queue" }
  /** Active turn in steer mode: interrupt it first, then start. */
  | { readonly action: "steer"; readonly supersededTurnId: string }
  /** Steer requested but the runtime cannot do it: fail, do not silently queue. */
  | { readonly action: "reject"; readonly code: SteerFailureCode; readonly message: string };

/**
 * Resolve what a sendTurn must do given the requested behavior and the
 * session's active turn. Steer with nothing running degrades to a plain
 * start; steer on a runtime without interrupt support rejects with
 * `steer_unsupported` so the caller surfaces it instead of hanging.
 */
export function resolveFollowUpAction(input: {
  readonly followUpBehavior?: FollowUpBehavior | undefined;
  readonly activeTurnId?: string | undefined;
  readonly supportsSteer: boolean;
}): FollowUpAction {
  const active = input.activeTurnId?.trim() ? input.activeTurnId : undefined;
  if (active === undefined) {
    return { action: "start" };
  }
  if (input.followUpBehavior === "steer") {
    if (!input.supportsSteer) {
      return {
        action: "reject",
        code: STEER_UNSUPPORTED,
        message: `Steer of turn '${active}' is not supported by this provider: interrupting the active turn is unavailable.`,
      };
    }
    return { action: "steer", supersededTurnId: active };
  }
  return { action: "queue" };
}

/** Minimal per-session turn bookkeeping shared by steer implementations. */
export interface FollowUpTurnState {
  readonly activeTurnId: string | undefined;
  readonly turnIds: ReadonlyArray<string>;
  readonly settledTurnIds: ReadonlySet<string>;
}

export function initialFollowUpTurnState(): FollowUpTurnState {
  return { activeTurnId: undefined, turnIds: [], settledTurnIds: new Set() };
}

/** Record a started turn: it takes over as active, lineage keeps every id. */
export function applyTurnStarted(state: FollowUpTurnState, turnId: string): FollowUpTurnState {
  return {
    activeTurnId: turnId,
    turnIds: state.turnIds.includes(turnId) ? state.turnIds : [...state.turnIds, turnId],
    settledTurnIds: state.settledTurnIds,
  };
}

/**
 * Record a settled turn. Only the active turn clears the active slot: a
 * superseded turn's late terminal settles that turn without stranding (or
 * clearing) the new active turn.
 */
export function applyTurnSettled(state: FollowUpTurnState, turnId: string): FollowUpTurnState {
  const settledTurnIds = state.settledTurnIds.has(turnId)
    ? state.settledTurnIds
    : new Set(state.settledTurnIds).add(turnId);
  return {
    activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
    turnIds: state.turnIds,
    settledTurnIds,
  };
}

export function isTurnSettled(state: FollowUpTurnState, turnId: string): boolean {
  return state.settledTurnIds.has(turnId);
}

/**
 * Per-session terminal watchers. A steer awaits the superseded turn's
 * terminal so its `turn.completed` is published before the new turn's
 * `turn.started`: lifecycle guards only let the active turn close, so the
 * order is what keeps the old turn from hanging unsettled. Entries are never
 * removed — a terminal noted before anyone waits still resolves a later
 * await — and the whole watcher drops with the session record.
 */
export interface TurnTerminalWatcher {
  readonly awaitTerminal: (turnId: string) => Effect.Effect<void>;
  readonly noteTerminal: (turnId: string) => Effect.Effect<void>;
}

export const makeTurnTerminalWatcher: Effect.Effect<TurnTerminalWatcher> = Effect.map(
  Effect.all({
    lock: Semaphore.make(1),
    watchers: Ref.make(new Map<string, Deferred.Deferred<void>>()),
  }),
  ({ lock, watchers }) => {
    const gateFor = (turnId: string) =>
      lock.withPermits(1)(
        Ref.get(watchers).pipe(
          Effect.flatMap((entries) => {
            const existing = entries.get(turnId);
            if (existing !== undefined) {
              return Effect.succeed(existing);
            }
            return Deferred.make<void>().pipe(
              Effect.tap((fresh) =>
                Ref.update(watchers, (next) => new Map(next).set(turnId, fresh)),
              ),
            );
          }),
        ),
      );
    return {
      awaitTerminal: (turnId: string) =>
        Effect.asVoid(Effect.flatMap(gateFor(turnId), (gate) => Deferred.await(gate))),
      noteTerminal: (turnId: string) =>
        Effect.flatMap(gateFor(turnId), (gate) =>
          Effect.asVoid(Deferred.complete(gate, Effect.void)),
        ),
    };
  },
);
