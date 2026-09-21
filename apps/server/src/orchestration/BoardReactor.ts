/**
 * BoardReactor - moves orchestrator kanban cards on terminal delegated
 * executor threads.
 *
 * A delegated child announces its end as a `delegation.completed` activity on
 * its parent thread. For every such activity the reactor looks up the card
 * whose `executorThreadId` matches the child and, while that card is
 * `in_progress`, records the outcome: success moves it to `review`; any
 * non-success keeps it `in_progress`, bumps `failureStreak`, and marks
 * `needs human` once the streak reaches three. It also clears
 * `executorThreadId` when an executor thread is deleted, because that column
 * has no foreign key and would otherwise dangle. Thread deletion is a soft
 * delete (`projection_threads.deleted_at`), so the board foreign keys never
 * fire; deleting an orchestrator thread therefore removes the orchestrator row
 * here, and cards plus history cascade from it.
 *
 * On startup it also recovers cards left `in_progress` by an executor session
 * orphaned during a restart: such a session never emits a terminal event, so
 * the reactor fails the card and wakes the orchestrator instead of leaving it
 * stuck.
 *
 * Every card change appends an append-only `board_card_events` row and posts a
 * card-context system message to the orchestrator thread, without an LLM call.
 *
 * @module BoardReactor
 */
import {
  type BoardCard,
  CommandId,
  DelegationCompletedActivityPayload,
  type IsoDateTime,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { BoardRepository, buildBoardCardEvent } from "../persistence/Services/Board.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/** Consecutive non-success executor finishes before a card is escalated. */
export const NEEDS_HUMAN_FAILURE_STREAK = 3;

/** Kind written by ProviderRuntimeIngestion when a delegated child turn ends. */
const DELEGATION_COMPLETED_ACTIVITY = "delegation.completed";

const decodeDelegationCompleted = Schema.decodeUnknownOption(DelegationCompletedActivityPayload);

const MAX_LAST_ERROR_LENGTH = 200;

type DelegationCompleted = DelegationCompletedActivityPayload;
type ActivityAppendedEvent = Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export class BoardReactor extends Context.Service<
  BoardReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/BoardReactor") {}

/** Cheap pre-filter so the worker never sees the full domain-event stream. */
function isDelegationCompletedEvent(event: OrchestrationEvent): event is ActivityAppendedEvent {
  return (
    event.type === "thread.activity-appended" &&
    event.payload.activity.kind === DELEGATION_COMPLETED_ACTIVITY
  );
}

function readDelegationCompleted(event: OrchestrationEvent): DelegationCompleted | null {
  if (!isDelegationCompletedEvent(event)) return null;
  return Option.getOrNull(decodeDelegationCompleted(event.payload.activity.payload));
}

/** A short, single-line fact for `lastError`; never the full provider message. */
function shortErrorNote(error: string | undefined, status: DelegationCompleted["status"]): string {
  const raw = (error ?? `executor turn ${status}`).trim().replace(/\s+/g, " ");
  return raw.length > MAX_LAST_ERROR_LENGTH ? `${raw.slice(0, MAX_LAST_ERROR_LENGTH - 3)}...` : raw;
}

function findCardForExecutor(
  cards: ReadonlyArray<BoardCard>,
  threadId: ThreadId,
): BoardCard | null {
  return cards.find((card) => card.executorThreadId === threadId) ?? null;
}

/** A card whose executor session was lost when the process restarted. */
const ORPHANED_EXECUTOR_NOTE = "executor session lost after restart";

const ORPHANED_EXECUTOR_WAKE_TEXT =
  "A delegated executor was lost when the server restarted and its board card was cancelled. Review the card and decide whether to retry, reassign, or escalate it.";

/** Idle means no live session turn and no pending or running turn. */
function isThreadIdle(
  shell: OrchestrationThreadShell,
  turns: ReadonlyArray<ProjectionTurn>,
): boolean {
  const session = shell.session ?? null;
  return !(
    (session !== null &&
      (session.activeTurnId !== null ||
        session.status === "running" ||
        session.status === "starting")) ||
    turns.some((turn) => turn.state === "pending" || turn.state === "running")
  );
}

/**
 * Whether the executor's thread still has a live session or an unfinished
 * turn. A missing shell or a thread without a session row is treated as alive,
 * so recovery never fails a card whose liveness it cannot read.
 */
function executorSessionIsLive(
  shell: OrchestrationThreadShell | undefined,
  turns: ReadonlyArray<ProjectionTurn>,
): boolean {
  if (shell === undefined) return true;
  const session = shell.session;
  if (session === null) return true;
  if (
    session.activeTurnId !== null ||
    session.status === "running" ||
    session.status === "starting"
  ) {
    return true;
  }
  return turns.some((turn) => turn.state === "pending" || turn.state === "running");
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const board = yield* BoardRepository;
  const snapshots = yield* ProjectionSnapshotQuery;
  const turnRepository = yield* ProjectionTurnRepository;

  const appendCardSystemMessage = (card: BoardCard, at: IsoDateTime, text: string, key: string) =>
    engine.dispatch({
      type: "thread.message.system.append",
      commandId: CommandId.make(`board:card:${card.cardId}:${key}`),
      threadId: card.orchestratorThreadId,
      message: {
        messageId: MessageId.make(`board:card:${card.cardId}:${key}`),
        text,
      },
      createdAt: at,
    });

  /**
   * Write a non-success finish: bump the streak, optionally clear the dead
   * executor reference, append history (with a separate `needs human` row at
   * the limit) and post the card-context system message.
   */
  const writeFailure = Effect.fn("BoardReactor.writeFailure")(function* (input: {
    readonly card: BoardCard;
    readonly at: IsoDateTime;
    readonly outcome: "failed" | "cancelled";
    readonly note: string;
    readonly clearExecutorThreadId: boolean;
    readonly key: string;
    readonly reason: string;
    /** Status to move the card to; omitted keeps the current status. */
    readonly status?: BoardCard["status"];
  }) {
    const failureStreak = input.card.failureStreak + 1;
    const needsHuman = failureStreak >= NEEDS_HUMAN_FAILURE_STREAK;
    const next: BoardCard = {
      ...input.card,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.clearExecutorThreadId ? { executorThreadId: null } : {}),
      outcome: input.outcome,
      lastError: input.note,
      failureStreak,
      updatedAt: input.at,
    };
    yield* board.updateCard(next);
    yield* board.appendEvent(
      buildBoardCardEvent(next, { at: input.at, body: `${input.reason}: ${input.outcome}` }),
    );
    if (needsHuman) {
      yield* board.appendEvent(buildBoardCardEvent(next, { at: input.at, body: "needs human" }));
    }
    yield* appendCardSystemMessage(
      next,
      input.at,
      `Board card "${next.title}" (${next.cardId}): ${input.reason} ${input.outcome} (failure streak ${failureStreak})${needsHuman ? " - needs human" : ""}. ${input.note}`,
      input.key,
    );
  });

  const handleDelegationCompleted = Effect.fn("BoardReactor.handleDelegationCompleted")(function* (
    event: ActivityAppendedEvent,
  ) {
    const terminal = readDelegationCompleted(event);
    if (terminal === null) return;
    const card = findCardForExecutor(yield* board.listCards(), terminal.childThreadId);
    // A missing card (already deleted) or a foreign executor id is a no-op.
    if (card === null || card.status !== "in_progress") return;
    const at = terminal.completedAt;

    if (terminal.status === "completed") {
      const next: BoardCard = {
        ...card,
        status: "review",
        outcome: "succeeded",
        lastError: null,
        failureStreak: 0,
        updatedAt: at,
      };
      yield* board.updateCard(next);
      yield* board.appendEvent(
        buildBoardCardEvent(next, {
          at,
          body: `executor ${card.executorRole} finished: success`,
        }),
      );
      yield* appendCardSystemMessage(
        next,
        at,
        `Board card "${next.title}" (${next.cardId}): executor finished successfully; moved to review.`,
        `terminal:${terminal.delegatedTurnId}`,
      );
      return;
    }

    yield* writeFailure({
      card,
      at,
      outcome: terminal.status === "cancelled" ? "cancelled" : "failed",
      note: shortErrorNote(terminal.terminalError, terminal.status),
      clearExecutorThreadId: false,
      key: `terminal:${terminal.delegatedTurnId}`,
      reason: `executor ${card.executorRole} finished`,
    });
  });

  const handleThreadDeleted = Effect.fn("BoardReactor.handleThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const orchestrators = yield* board.listOrchestrators();
    if (orchestrators.some((orchestrator) => orchestrator.threadId === event.payload.threadId)) {
      // Thread deletion is a soft delete, so the FK cascade never fires here.
      yield* board.removeOrchestrator(event.payload.threadId);
      return;
    }
    const card = findCardForExecutor(yield* board.listCards(), event.payload.threadId);
    if (card === null) return;
    const at = event.payload.deletedAt;
    if (card.status === "in_progress") {
      // The executor can never emit a terminal event now; keep the loss visible.
      yield* writeFailure({
        card,
        at,
        outcome: "cancelled",
        note: "executor thread deleted",
        clearExecutorThreadId: true,
        key: "executor-thread-deleted",
        reason: "executor thread deleted while in progress",
      });
      return;
    }
    const next: BoardCard = { ...card, executorThreadId: null, updatedAt: at };
    yield* board.updateCard(next);
    yield* board.appendEvent(buildBoardCardEvent(next, { at, body: "executor thread deleted" }));
  });

  const wakeOrchestrator = Effect.fn("BoardReactor.wakeOrchestrator")(function* (
    card: BoardCard,
    at: IsoDateTime,
  ) {
    const shell = Option.getOrUndefined(
      yield* snapshots.getThreadShellById(card.orchestratorThreadId),
    );
    if (shell === undefined) return;
    const turns = yield* turnRepository.listByThreadId({ threadId: card.orchestratorThreadId });
    if (!isThreadIdle(shell, turns)) return;
    const wakeId = `board:card-wake:${card.cardId}`;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(wakeId),
      threadId: card.orchestratorThreadId,
      message: {
        messageId: MessageId.make(wakeId),
        role: "user",
        text: ORPHANED_EXECUTOR_WAKE_TEXT,
        attachments: [],
      },
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      createdAt: at,
    });
  });

  /**
   * Startup recovery for cards whose executor session was orphaned by a
   * restart. An orphaned session never emits a terminal provider event, so the
   * delegation wake never runs; fail the card through the normal failure path
   * and wake the orchestrator to re-route it.
   */
  const recoverOrphanedExecutors = Effect.fn("BoardReactor.recoverOrphanedExecutors")(function* () {
    const candidates = (yield* board.listCards()).filter(
      (card) => card.status === "in_progress" && card.executorThreadId !== null,
    );
    if (candidates.length === 0) return;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.forEach(
      candidates,
      (card) =>
        Effect.gen(function* () {
          const threadId = card.executorThreadId!;
          const shell = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
          const turns = yield* turnRepository.listByThreadId({ threadId });
          if (executorSessionIsLive(shell, turns)) return;
          yield* writeFailure({
            card,
            at,
            status: "orchestrator",
            outcome: "cancelled",
            note: ORPHANED_EXECUTOR_NOTE,
            clearExecutorThreadId: true,
            key: "executor-orphaned-after-restart",
            reason: "executor session lost after restart",
          });
          yield* wakeOrchestrator(card, at);
        }),
      { discard: true },
    );
  });

  const processEvent = Effect.fn("BoardReactor.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type === "thread.activity-appended") {
      yield* handleDelegationCompleted(event);
    } else if (event.type === "thread.deleted") {
      yield* handleThreadDeleted(event);
    }
  });

  type BoardTask =
    | { readonly kind: "event"; readonly event: OrchestrationEvent }
    | { readonly kind: "recover" };

  const processTask = Effect.fn("BoardReactor.processTask")(function* (task: BoardTask) {
    if (task.kind === "recover") {
      yield* recoverOrphanedExecutors();
      return;
    }
    yield* processEvent(task.event);
  });

  const processTaskSafely = (task: BoardTask) =>
    processTask(task).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("board reactor task failed", {
              task: task.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processTaskSafely);

  const start: BoardReactor["Service"]["start"] = Effect.fn("BoardReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        isDelegationCompletedEvent(event) || event.type === "thread.deleted"
          ? worker.enqueue({ kind: "event", event })
          : Effect.void,
      ),
    );
    // Parked at the activation boundary so startup reconciliation has already
    // settled orphaned provider sessions to `error` when the sweep reads them.
    yield* forkParked(worker.enqueue({ kind: "recover" }));
  });

  return { start, drain: worker.drain } satisfies BoardReactor["Service"];
});

export const layer = Layer.effect(BoardReactor, make);
