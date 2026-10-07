/**
 * Physical erasure of soft-deleted threads past their purge age.
 *
 * A thread whose `projection_threads.deleted_at` is at least
 * `deletedThreadPurgeAfterDays` old (boundary inclusive: exactly N days
 * counts as due) is erased at server start, before the command read model
 * loads. One thread is erased per transaction (`sql.withTransaction`: the
 * codebase-idiomatic atomic unit; startup runs single-threaded, so no other
 * writer can interleave), and the pass stops cleanly when its time budget
 * runs out between threads. Whatever is left is picked up on the next
 * start.
 *
 * What is erased for a thread X is the amendment's table list (§2.2),
 * ordered from referencing rows to referenced rows so no foreign key is
 * violated and no cascade is relied upon:
 *
 * 1. live references *to* X are nulled, never deleted
 *    (`projection_thread_proposed_plans.implementation_thread_id`,
 *    `projection_turns.source_proposed_plan_thread_id`);
 * 2. coordinator-side `architecture_review` rows, then
 *    `coordinator_architect_binding` rows (an architect-side row stays as
 *    audit while its coordinator lives);
 * 3. `board_orchestrators` (cards and their history follow through the
 *    existing cascade);
 * 4. `delegated_turn_send_queue`,
 *    `projection_delegated_task_summaries` (child or parent side),
 *    `calendar_events`, `provider_session_runtime`, `checkpoint_diff_blobs`;
 * 5. per-thread projections: proposed plans, pull requests, pending
 *    approvals, turns, sessions, messages, activities;
 * 6. `orchestration_command_receipts`, then the thread's
 *    `orchestration_events` stream (sequence gaps are expected: cursors
 *    compare with "greater than");
 * 7. the `projection_threads` row itself, last.
 *
 * Never touched: worktrees and branches on disk, provider-side histories,
 * live threads, and deleted threads younger than the cutoff. No VACUUM is
 * issued: freed pages are reused by later writes. Nobody is woken and
 * nothing is published: the pass uses only SQL.
 *
 * @module DeletedThreadPurge
 */
import type { ServerSettingsError, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Wall-clock budget for one startup purge pass. */
export const DELETED_THREAD_PURGE_BUDGET_MS = 30_000;

/** Candidates are fetched in batches; each batch is re-read after purging. */
export const DELETED_THREAD_PURGE_BATCH_LIMIT = 500;

export interface DeletedThreadPurgeCounts {
  readonly purgedThreads: number;
  readonly purgedEvents: number;
  readonly purgedRows: number;
  readonly stoppedEarly: boolean;
}

const mapPurgeError = toPersistenceSqlError("DeletedThreadPurge:query");

interface CountedRow {
  readonly count: number;
}

const changesCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CountedRow>`SELECT changes() AS "count"`;
  return rows[0]?.count ?? 0;
});

/**
 * Erase every row listed in §2.2 for one thread, atomically. Live
 * references to the thread are nulled; everything else is deleted from
 * referencing tables down to the thread row itself.
 */
export const purgeDeletedThread = Effect.fn("DeletedThreadPurge.purgeDeletedThread")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        let rows = 0;
        const exec = <A, E, R>(statement: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            yield* statement;
            rows += yield* changesCount;
          });
        // Live threads pointing at X keep their rows; only the link is cut.
        yield* exec(
          sql`
              UPDATE projection_thread_proposed_plans
              SET implementation_thread_id = NULL
              WHERE implementation_thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              UPDATE projection_turns
              SET source_proposed_plan_thread_id = NULL
              WHERE source_proposed_plan_thread_id = ${threadId}
            `,
        );
        // Coordinator-side reviews and binding. Architect-side rows stay
        // as audit while their coordinator lives.
        yield* exec(
          sql`
              DELETE FROM architecture_review
              WHERE coordinator_thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM coordinator_architect_binding
              WHERE coordinator_thread_id = ${threadId}
            `,
        );
        // Cards and their history follow through the existing cascade.
        yield* exec(
          sql`
              DELETE FROM board_orchestrators
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM delegated_turn_send_queue
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_delegated_task_summaries
              WHERE child_thread_id = ${threadId} OR parent_thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM calendar_events
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM provider_session_runtime
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM checkpoint_diff_blobs
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_thread_proposed_plans
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_thread_pull_requests
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_pending_approvals
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_turns
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_thread_sessions
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_thread_messages
              WHERE thread_id = ${threadId}
            `,
        );
        yield* exec(
          sql`
              DELETE FROM projection_thread_activities
              WHERE thread_id = ${threadId}
            `,
        );
        const receipts = yield* sql<CountedRow>`
            SELECT COUNT(*) AS "count"
            FROM orchestration_command_receipts
            WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
          `;
        yield* exec(
          sql`
              DELETE FROM orchestration_command_receipts
              WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
            `,
        );
        const events = yield* sql<CountedRow>`
            SELECT COUNT(*) AS "count"
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          `;
        yield* exec(
          sql`
              DELETE FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            `,
        );
        // Last: other rows reference this one through foreign keys.
        yield* exec(
          sql`
              DELETE FROM projection_threads
              WHERE thread_id = ${threadId}
            `,
        );
        return {
          events: events[0]?.count ?? 0,
          receipts: receipts[0]?.count ?? 0,
          rows,
        };
      }),
    )
    .pipe(Effect.mapError(mapPurgeError));
});

interface PurgeCandidateRow {
  readonly threadId: ThreadId;
}

/**
 * Threads deleted at or before the cutoff, oldest first. Selection is by
 * `deleted_at` — never by `updated_at`, which a later touch can move.
 * The boundary is inclusive: `deleted_at <= cutoff` erases a thread
 * deleted exactly `afterDays` ago.
 */
export const listDeletedThreadPurgeCandidates = Effect.fn(
  "DeletedThreadPurge.listDeletedThreadPurgeCandidates",
)(function* (cutoffIso: string, limit: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<PurgeCandidateRow>`
    SELECT thread_id AS "threadId"
    FROM projection_threads
    WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoffIso}
    ORDER BY deleted_at ASC, thread_id ASC
    LIMIT ${limit}
  `.pipe(Effect.mapError(mapPurgeError));
});

/** Cutoff instant: `now` minus `afterDays` whole days, ISO for comparison. */
export const deletedThreadPurgeCutoffIso = (afterDays: number, now: DateTime.DateTime): string =>
  DateTime.formatIso(DateTime.subtract(now, { days: afterDays }));

export interface PurgeDeletedThreadsOptions {
  readonly cutoffIso: string;
  readonly budgetMs?: number;
  readonly batchLimit?: number;
  /** Clock source; defaults to the wall clock. Tests inject a counter. */
  readonly nowMs?: Effect.Effect<number, never, never>;
}

/**
 * Erase candidates thread by thread until none remain or the budget runs
 * out. The budget is checked between threads, never inside one, so the
 * database is always left consistent and the next start resumes.
 */
export const purgeDeletedThreads = Effect.fn("DeletedThreadPurge.purgeDeletedThreads")(function* (
  options: PurgeDeletedThreadsOptions,
) {
  const budgetMs = options.budgetMs ?? DELETED_THREAD_PURGE_BUDGET_MS;
  const batchLimit = options.batchLimit ?? DELETED_THREAD_PURGE_BATCH_LIMIT;
  const nowMs = options.nowMs ?? Clock.currentTimeMillis;
  const startedAt = yield* nowMs;
  let purgedThreads = 0;
  let purgedEvents = 0;
  let purgedRows = 0;
  let stoppedEarly = false;
  for (;;) {
    if ((yield* nowMs) - startedAt >= budgetMs) {
      stoppedEarly = true;
      break;
    }
    const candidates = yield* listDeletedThreadPurgeCandidates(options.cutoffIso, batchLimit);
    if (candidates.length === 0) {
      break;
    }
    for (const candidate of candidates) {
      if ((yield* nowMs) - startedAt >= budgetMs) {
        stoppedEarly = true;
        break;
      }
      const purged = yield* purgeDeletedThread(candidate.threadId);
      purgedThreads += 1;
      purgedEvents += purged.events;
      purgedRows += purged.rows + purged.events + purged.receipts;
    }
    if (stoppedEarly) {
      break;
    }
  }
  return { purgedThreads, purgedEvents, purgedRows, stoppedEarly };
});

/**
 * Startup pass: erase threads deleted at least
 * `deletedThreadPurgeAfterDays` ago, within the time budget. Runs before
 * the projection pipeline bootstrap so the command read model never sees
 * an erased thread. Logs only counts, never contents.
 */
export const purgeDeletedThreadsAtEngineStart: Effect.Effect<
  DeletedThreadPurgeCounts,
  PersistenceSqlError | ServerSettingsError,
  SqlClient.SqlClient | ServerSettingsService
> = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings;
  const afterDays = current.deletedThreadPurgeAfterDays;
  const cutoffIso = deletedThreadPurgeCutoffIso(afterDays, yield* DateTime.now);
  const counts = yield* purgeDeletedThreads({ cutoffIso });
  yield* Effect.logInfo("deleted thread purge", {
    afterDays,
    purgedThreads: counts.purgedThreads,
    purgedEvents: counts.purgedEvents,
    purgedRows: counts.purgedRows,
    stoppedEarly: counts.stoppedEarly,
  });
  return counts;
});
