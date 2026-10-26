import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../../apps/server/src/orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../../apps/server/src/serverActivation.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";
import { buildBoardWakePrompt } from "./boardWakePrompt.ts";

export class BoardReactorError extends Schema.TaggedError<BoardReactorError>()(
  "BoardReactorError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `The board reactor could not ${this.operation}.`;
  }
}

export class BoardReactor extends Context.Service<
  BoardReactor,
  {
    readonly process: (event: OrchestrationV2StoredEvent) => Effect.Effect<void, BoardReactorError>;
    readonly recover: Effect.Effect<void, BoardReactorError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/ft3-board/BoardReactor") {}

const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
const active = (status: string) =>
  ["pending", "queued", "preparing", "starting", "running", "waiting"].includes(status);
const decodeTaskIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeTaskIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const failure = (operation: string) => (cause: unknown) =>
  new BoardReactorError({ operation, cause });

const make = Effect.fn("Ft3BoardReactor.make")(function* (modelSelectionPolicyRef: string) {
  const sql = yield* SqlClient.SqlClient;
  const board = yield* BoardRepository.BoardRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const lane = yield* Semaphore.make(1);

  const cursor = Effect.fn("Ft3BoardReactor.cursor")(function* () {
    const rows = yield* sql<{
      readonly sequence: number;
    }>`SELECT sequence FROM ft3_board_reactor_cursor WHERE id = 1`;
    return rows[0]!.sequence;
  });
  const cardsForExecutor = Effect.fn("Ft3BoardReactor.cardsForExecutor")(function* (
    executorId: ThreadId,
  ) {
    const rows = yield* sql<{
      readonly cardId: string;
    }>`SELECT card_id AS "cardId" FROM ft3_board_cards WHERE executor_thread_id = ${executorId}`;
    const cards = yield* Effect.forEach(rows, (row) =>
      board.getCard(Contracts.BoardCardId.make(row.cardId)),
    );
    return cards.filter((card) => card !== null);
  });
  const executorRecords = (id: ThreadId) =>
    threads.getThreadRecords(id, ["runs", "providerTurns", "providerThreads", "subagents"]);
  const hasOwnTurnWork = (records: Effect.Success<ReturnType<typeof executorRecords>>) =>
    records.runs.some((run) => active(run.status)) ||
    records.providerTurns.some((turn) => active(turn.status)) ||
    records.providerThreads.some((thread) => thread.status === "active");
  const hasWork = (records: Effect.Success<ReturnType<typeof executorRecords>>) =>
    hasOwnTurnWork(records) ||
    records.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0) ||
    records.subagents.some((task) => active(task.status));

  const enqueue = Effect.fn("Ft3BoardReactor.enqueue")(function* (
    key: string,
    targetId: ThreadId,
    executorId: ThreadId,
    context: string,
  ) {
    yield* sql`INSERT INTO ft3_board_reactor_wakes (wake_key, orchestrator_thread_id, executor_thread_id, context)
      SELECT ${key}, thread_id, ${executorId}, ${context} FROM ft3_board_orchestrators
      WHERE thread_id = ${targetId} AND created_by = 'human' ON CONFLICT DO NOTHING`;
  });

  const writeOutcome = Effect.fn("Ft3BoardReactor.writeOutcome")(function* (
    card: Contracts.BoardCard,
    executionKey: string,
    status: string,
    at: string,
    orphaned = false,
  ) {
    if (card.status !== "in_progress" || card.archived || card.updatedAt > at) return;
    const inserted =
      yield* sql`INSERT INTO ft3_board_reactor_outcomes (card_id, execution_key) VALUES (${card.cardId}, ${executionKey}) ON CONFLICT DO NOTHING RETURNING card_id`;
    if (inserted.length === 0) return;
    const succeeded = status === "completed";
    const failureStreak = succeeded ? 0 : card.failureStreak + 1;
    const note = orphaned ? "executor session lost after restart" : `executor turn ${status}`;
    const needsHuman = !succeeded && failureStreak >= 3 && card.readiness !== "needs_human";
    const next: Contracts.BoardCard = {
      ...card,
      status: orphaned ? "orchestrator" : succeeded ? "review" : card.status,
      outcome: succeeded
        ? "succeeded"
        : ["cancelled", "interrupted", "rolled_back"].includes(status)
          ? "cancelled"
          : "failed",
      failureStreak,
      lastError: succeeded ? null : note,
      ...(orphaned ? { executorThreadId: null } : {}),
      ...(needsHuman
        ? {
            readiness: "needs_human",
            readinessNote: `${failureStreak} executor failures in a row; last: ${note}`,
          }
        : {}),
      updatedAt: at,
    };
    const event: Contracts.BoardCardEvent = {
      entryId: Contracts.BoardCardEventId.make(`ft3:board:outcome:${card.cardId}:${executionKey}`),
      cardId: card.cardId,
      at,
      status: next.status,
      executorRole: next.executorRole,
      model: next.assignee?.model ?? null,
      effort:
        next.assignee?.options
          ?.find((option) => option.id === "effort" || option.id === "reasoningEffort")
          ?.value?.toString() ?? null,
      body: note,
      source: "system",
    };
    yield* board.updateCard(
      next,
      needsHuman
        ? [
            event,
            {
              ...event,
              entryId: Contracts.BoardCardEventId.make(`${event.entryId}:readiness`),
              body: `readiness -> needs_human: ${next.readinessNote}`,
            },
          ]
        : [event],
    );
  });

  const cleanup = Effect.fn("Ft3BoardReactor.cleanup")(function* (threadId: ThreadId, at: string) {
    yield* sql`INSERT INTO ft3_board_card_deletions (card_id, orchestrator_thread_id, deleted_at, reason, history_event_count)
      SELECT card_id, orchestrator_thread_id, ${at}, 'executor-thread-deleted',
        (SELECT COUNT(*) FROM ft3_board_card_events e WHERE e.card_id = c.card_id)
      FROM ft3_board_cards c WHERE executor_thread_id = ${threadId} ON CONFLICT DO NOTHING`;
    yield* sql`DELETE FROM ft3_board_cards WHERE executor_thread_id = ${threadId}`;
    yield* sql`DELETE FROM ft3_board_orchestrators WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM ft3_board_reactor_wakes WHERE executor_thread_id = ${threadId}`;
    yield* sql`DELETE FROM ft3_board_reactor_background WHERE thread_id = ${threadId}`;
  });

  const stage = Effect.fn("Ft3BoardReactor.stage")(function* (stored: OrchestrationV2StoredEvent) {
    const { event } = stored;
    const at = DateTime.formatIso(event.occurredAt);
    if (event.type === "thread.deleted") {
      yield* cleanup(event.threadId, at);
      return;
    }
    let executorId = event.threadId;
    let parentId: ThreadId | null = null;
    let reason: string | null = null;
    let outcome: { readonly status: string; readonly key: string } | null = null;
    switch (event.type) {
      case "subagent.updated": {
        const task = event.payload;
        if (task.origin !== "app_owned" || task.childThreadId === null || !terminal(task.status))
          return;
        executorId = task.childThreadId;
        parentId = task.threadId;
        reason = `Delegated task ${task.id} ${task.status}.`;
        outcome = {
          status: task.status,
          key: `task:${task.id}:${DateTime.formatIso(task.completedAt ?? task.updatedAt)}`,
        };
        break;
      }
      case "run.updated":
        if (!terminal(event.payload.status)) return;
        reason = `Executor run ${event.payload.id} ${event.payload.status}.`;
        outcome = { status: event.payload.status, key: event.payload.id };
        break;
      case "runtime-request.updated":
        if (event.payload.kind !== "user_input" || event.payload.status !== "pending") return;
        reason = `Executor requested human input (${event.payload.id}).`;
        break;
      case "provider-thread.updated": {
        const provider = event.payload;
        const rows = yield* sql<{
          readonly taskIds: string;
        }>`SELECT task_ids_json AS "taskIds" FROM ft3_board_reactor_background WHERE provider_thread_id = ${provider.id}`;
        const previous = rows[0] === undefined ? [] : yield* decodeTaskIds(rows[0].taskIds);
        const current = (provider.pendingBackgroundTasks ?? []).map((task) => task.taskId);
        const encoded = yield* encodeTaskIds(current);
        yield* sql`INSERT INTO ft3_board_reactor_background (provider_thread_id, thread_id, task_ids_json)
          VALUES (${provider.id}, ${executorId}, ${encoded})
          ON CONFLICT (provider_thread_id) DO UPDATE SET thread_id = excluded.thread_id, task_ids_json = excluded.task_ids_json`;
        if (!previous.some((id) => !current.includes(id))) return;
        reason = "Executor background work finished.";
        break;
      }
      default:
        return;
    }
    const shell = yield* threads.getThreadShell(executorId);
    if (shell === null || shell.deletedAt !== null) return;
    if (outcome !== null) {
      const records = yield* executorRecords(executorId);
      if (hasWork(records)) outcome = null;
      else if (event.type === "subagent.updated") {
        const run = records.runs
          .filter(
            (run) =>
              terminal(run.status) && DateTime.formatIso(run.completedAt ?? run.requestedAt) <= at,
          )
          .toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (run !== undefined) outcome = { status: event.payload.status, key: run.id };
      }
    }
    if (shell.lineage.relationshipToParent === "subagent")
      parentId ??= shell.lineage.parentThreadId;
    const cards = yield* cardsForExecutor(executorId);
    const targets = new Set(
      cards.filter((card) => !card.archived).map((card) => card.orchestratorThreadId),
    );
    if (
      parentId !== null &&
      shell.lineage.parentThreadId === parentId &&
      shell.lineage.relationshipToParent === "subagent"
    )
      targets.add(parentId);
    const marks = yield* board.listOrchestrators();
    for (const targetId of targets) {
      if (
        targetId === executorId ||
        !marks.some(
          (mark) =>
            mark.threadId === targetId && mark.createdBy === "human" && mark.createdAt <= at,
        )
      )
        continue;
      if (outcome !== null) {
        for (const card of cards.filter((card) => card.orchestratorThreadId === targetId)) {
          yield* writeOutcome(card, outcome.key, outcome.status, at);
        }
      }
      const cardContext = (yield* board.listCards(targetId))
        .filter((card) => card.executorThreadId === executorId && !card.archived)
        .map(
          (card) =>
            `Card ${card.cardId}: status=${card.status}; readiness=${card.readiness}; outcome=${card.outcome ?? "none"}; failureStreak=${card.failureStreak}.`,
        )
        .join("\n");
      yield* enqueue(
        `ft3:board:wake:${stored.sequence}:${targetId}`,
        targetId,
        executorId,
        `${reason}\nExecutor thread: ${executorId}.\n${cardContext}`,
      );
    }
  });

  const drain = Effect.fn("Ft3BoardReactor.drain")(function* () {
    const wakes = yield* sql<{
      readonly key: string;
      readonly target: string;
      readonly executor: string;
      readonly context: string;
    }>`SELECT wake_key AS "key", orchestrator_thread_id AS target, executor_thread_id AS executor, context FROM ft3_board_reactor_wakes ORDER BY rowid`;
    for (const wake of wakes) {
      const targetId = ThreadId.make(wake.target);
      const marks = yield* board.listOrchestrators();
      const shell = yield* threads.getThreadShell(targetId);
      const executor = yield* threads.getThreadShell(ThreadId.make(wake.executor));
      if (
        !marks.some((mark) => mark.threadId === targetId && mark.createdBy === "human") ||
        shell === null ||
        shell.deletedAt !== null ||
        executor?.deletedAt != null
      ) {
        yield* sql`DELETE FROM ft3_board_reactor_wakes WHERE wake_key = ${wake.key}`;
        continue;
      }
      if (
        shell.activeRunId !== null ||
        active(shell.status) ||
        shell.pendingRuntimeRequest !== null ||
        hasOwnTurnWork(yield* executorRecords(targetId))
      )
        continue;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(wake.key),
        threadId: targetId,
        messageId: MessageId.make(wake.key),
        text: buildBoardWakePrompt(modelSelectionPolicyRef, wake.context),
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
      yield* sql`DELETE FROM ft3_board_reactor_wakes WHERE wake_key = ${wake.key}`;
    }
  });

  const process = Effect.fn("Ft3BoardReactor.process")(
    function* (stored: OrchestrationV2StoredEvent) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (stored.sequence <= (yield* cursor())) return;
          yield* stage(stored);
          yield* sql`UPDATE ft3_board_reactor_cursor SET sequence = ${stored.sequence} WHERE id = 1`;
        }),
      );
      yield* drain();
    },
    (effect) => lane.withPermit(effect),
    Effect.mapError(failure("process event")),
  );

  const recoverOrphans = Effect.fn("Ft3BoardReactor.recoverOrphans")(function* () {
    const at = DateTime.formatIso(yield* DateTime.now);
    for (const mark of yield* board.listOrchestrators()) {
      if (mark.createdBy !== "human") continue;
      for (const card of yield* board.listCards(mark.threadId)) {
        if (card.status !== "in_progress" || card.archived || card.executorThreadId === null)
          continue;
        const shell = yield* threads.getThreadShell(card.executorThreadId);
        if (
          shell === null ||
          shell.deletedAt !== null ||
          shell.activeRunId !== null ||
          active(shell.status)
        )
          continue;
        const records = yield* executorRecords(card.executorThreadId);
        if (records.providerThreads.length === 0 || hasWork(records)) continue;
        const key = `ft3:board:orphan:${card.cardId}:${card.executorThreadId}:${card.updatedAt}`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* board.getCard(card.cardId);
            if (
              current === null ||
              current.updatedAt !== card.updatedAt ||
              current.executorThreadId !== card.executorThreadId
            )
              return;
            yield* writeOutcome(current, key, "cancelled", at, true);
            yield* enqueue(
              key,
              mark.threadId,
              card.executorThreadId!,
              `A delegated executor was lost when the server restarted. Card ${card.cardId}: status=orchestrator; outcome=cancelled. Review the card and decide whether to retry, reassign, or escalate it.`,
            );
          }),
        );
      }
    }
  });

  const recover = Effect.gen(function* () {
    const afterSequence = yield* cursor();
    const throughSequence = yield* sink.latestSequence();
    if (throughSequence > afterSequence) {
      yield* sink.stream({ afterSequence }).pipe(
        Stream.takeUntil((stored) => stored.sequence >= throughSequence),
        Stream.runForEach(process),
      );
    }
    yield* lane.withPermit(recoverOrphans().pipe(Effect.andThen(drain())));
  }).pipe(Effect.mapError(failure("recover")));

  const start = Effect.fn("Ft3BoardReactor.start")(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* recover;
        const afterSequence = yield* cursor();
        yield* sink.stream({ afterSequence }).pipe(Stream.runForEach(process));
      }).pipe(
        Effect.tapError(() =>
          Effect.logWarning("Board reactor failed; resuming from its durable cursor"),
        ),
        Effect.retry(Schedule.spaced("1 second")),
      ),
    );
  });
  return BoardReactor.of({ process, recover, start });
});

export const layer = (modelSelectionPolicyRef = "") =>
  Layer.effect(BoardReactor, make(modelSelectionPolicyRef));

export const layerWorker = (modelSelectionPolicyRef = "") =>
  Layer.effectDiscard(Effect.flatMap(BoardReactor, (reactor) => reactor.start())).pipe(
    Layer.provide(layer(modelSelectionPolicyRef)),
    Layer.provide(BoardRepository.layer),
  );
