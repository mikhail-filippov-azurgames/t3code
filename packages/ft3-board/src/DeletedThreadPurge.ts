/**
 * Physical erasure of soft-deleted threads past their purge age.
 *
 * A thread whose `orchestration_v2_projection_threads.deleted_at` is at least
 * `deletedThreadPurgeAfterDays` old (boundary inclusive) is erased at server
 * start. One thread is erased per transaction, and the pass stops cleanly when
 * its time budget runs out between threads. Whatever is left is picked up on
 * the next start.
 *
 * Never touched: worktrees and branches on disk, provider-side histories, live
 * threads, and deleted threads younger than the cutoff. No VACUUM is issued.
 *
 * @module DeletedThreadPurge
 */
import type { ServerSettingsError, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import { readBoardAutomationSettings } from "./settings.ts";

export const DELETED_THREAD_PURGE_BUDGET_MS = 30_000;
export const DELETED_THREAD_PURGE_BATCH_LIMIT = 500;

export interface DeletedThreadPurgeCounts {
  readonly purgedThreads: number;
  readonly purgedEvents: number;
  readonly purgedRows: number;
  readonly stoppedEarly: boolean;
}

interface CountedRow {
  readonly count: number;
}

const changesCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CountedRow>`SELECT changes() AS "count"`;
  return rows[0]?.count ?? 0;
});

/**
 * Erase every V2 and ft3 row owned by one thread, atomically. References from
 * live threads that cannot be nulled are removed with the transfer record.
 */
export const purgeDeletedThread = Effect.fn("DeletedThreadPurge.purgeDeletedThread")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let rows = 0;
      const exec = Effect.fn("DeletedThreadPurge.exec")(function* <A, E, R>(
        statement: Effect.Effect<A, E, R>,
      ) {
        yield* statement;
        rows += yield* changesCount;
      });
      yield* exec(sql`DELETE FROM ft3_architect_review WHERE coordinator_thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM ft3_architect_binding WHERE coordinator_thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM ft3_board_orchestrators WHERE thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM ft3_board_cards WHERE executor_thread_id = ${threadId}`);
      yield* exec(
        sql`DELETE FROM ft3_delegated_task_summaries WHERE child_thread_id = ${threadId} OR parent_thread_id = ${threadId}`,
      );
      yield* exec(sql`DELETE FROM ft3_task_handoffs WHERE parent_thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM scheduled_tasks WHERE thread_id = ${threadId}`);
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_context_transfers WHERE source_thread_id = ${threadId} OR target_thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_context_handoffs WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_checkpoints WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}`,
      );
      yield* exec(sql`DELETE FROM orchestration_v2_projection_plans WHERE thread_id = ${threadId}`);
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_provider_turns WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ${threadId}`,
      );
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId} OR child_thread_id = ${threadId}`,
      );
      yield* exec(sql`DELETE FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId}`);
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${threadId}`,
      );
      yield* exec(sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}`);
      yield* exec(
        sql`DELETE FROM orchestration_v2_thread_launch_workflows WHERE thread_id = ${threadId}`,
      );
      yield* exec(sql`DELETE FROM orchestration_v2_legacy_imports WHERE thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM orchestration_v2_events WHERE thread_id = ${threadId}`);
      yield* exec(sql`DELETE FROM orchestration_v2_command_receipts WHERE thread_id = ${threadId}`);
      yield* exec(
        sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`,
      );
      return { rows };
    }),
  );
});

interface PurgeCandidateRow {
  readonly threadId: ThreadId;
}

/** Threads deleted at or before the cutoff, oldest first (inclusive boundary). */
export const listDeletedThreadPurgeCandidates = Effect.fn(
  "DeletedThreadPurge.listDeletedThreadPurgeCandidates",
)(function* (cutoffIso: string, limit: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<PurgeCandidateRow>`
    SELECT thread_id AS "threadId"
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoffIso}
    ORDER BY deleted_at ASC, thread_id ASC
    LIMIT ${limit}
  `;
});

/** Cutoff instant: `now` minus `afterDays` whole days, ISO for comparison. */
export const deletedThreadPurgeCutoffIso = (afterDays: number, now: DateTime.DateTime): string =>
  DateTime.formatIso(DateTime.subtract(now, { days: afterDays }));

export interface PurgeDeletedThreadsOptions {
  readonly cutoffIso: string;
  readonly budgetMs?: number;
  readonly batchLimit?: number;
  readonly nowMs?: Effect.Effect<number, never, never>;
}

/** Erase candidates thread by thread until none remain or the budget runs out. */
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
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      if ((yield* nowMs) - startedAt >= budgetMs) {
        stoppedEarly = true;
        break;
      }
      yield* purgeDeletedThread(candidate.threadId);
      purgedThreads += 1;
      purgedRows += 1;
    }
    if (stoppedEarly) break;
  }
  return { purgedThreads, purgedEvents, purgedRows, stoppedEarly };
});

/** Startup pass: erase threads deleted at least the configured period ago. */
export const purgeDeletedThreadsAtEngineStart: Effect.Effect<
  DeletedThreadPurgeCounts,
  ServerSettingsError | SqlError,
  SqlClient.SqlClient | ServerSettingsService
> = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings;
  const afterDays = readBoardAutomationSettings(current.ft3).deletedThreadPurgeAfterDays;
  const cutoffIso = deletedThreadPurgeCutoffIso(afterDays, yield* DateTime.now);
  const counts = yield* purgeDeletedThreads({ cutoffIso });
  yield* Effect.logInfo("deleted thread purge", {
    afterDays,
    purgedThreads: counts.purgedThreads,
    purgedRows: counts.purgedRows,
    stoppedEarly: counts.stoppedEarly,
  });
  return counts;
});

export const layerWorker = () =>
  Layer.effectDiscard(purgeDeletedThreadsAtEngineStart.pipe(Effect.asVoid));
