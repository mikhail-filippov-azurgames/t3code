// @effect-diagnostics nodeBuiltinImport:off
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations as runCoreMigrations } from "../../../apps/server/src/persistence/Migrations.ts";
import { runMigrations } from "../../ft3-host/src/Migrations.ts";
import {
  deletedThreadPurgeCutoffIso,
  listDeletedThreadPurgeCandidates,
  purgeDeletedThread,
  purgeDeletedThreads,
} from "./DeletedThreadPurge.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const NOW = "2026-06-15T12:00:00.000Z";
const NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const NOW_INSTANT = DateTime.makeUnsafe(NOW);

const isoDaysAgo = (days: number): string =>
  DateTime.formatIso(DateTime.subtract(NOW_INSTANT, { days }));
const cutoff14 = (): string => deletedThreadPurgeCutoffIso(14, NOW_INSTANT);

interface TableCounts {
  readonly threads: number;
  readonly events: number;
  readonly receipts: number;
  readonly messages: number;
  readonly runs: number;
  readonly turnItems: number;
  readonly providerThreads: number;
  readonly orchestrators: number;
  readonly cards: number;
  readonly scheduled: number;
}

const countFor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<TableCounts>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}) AS "threads",
        (SELECT COUNT(*) FROM orchestration_v2_events WHERE thread_id = ${threadId}) AS "events",
        (SELECT COUNT(*) FROM orchestration_v2_command_receipts WHERE thread_id = ${threadId}) AS "receipts",
        (SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}) AS "messages",
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}) AS "runs",
        (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}) AS "turnItems",
        (SELECT COUNT(*) FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}) AS "providerThreads",
        (SELECT COUNT(*) FROM ft3_board_orchestrators WHERE thread_id = ${threadId}) AS "orchestrators",
        (SELECT COUNT(*) FROM ft3_board_cards WHERE orchestrator_thread_id = ${threadId}) AS "cards",
        (SELECT COUNT(*) FROM scheduled_tasks WHERE thread_id = ${threadId}) AS "scheduled"
    `;
    return rows[0] as TableCounts;
  });

const zeroCounts: TableCounts = {
  threads: 0,
  events: 0,
  receipts: 0,
  messages: 0,
  runs: 0,
  turnItems: 0,
  providerThreads: 0,
  orchestrators: 0,
  cards: 0,
  scheduled: 0,
};

const seedThread = (name: string, deletedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make(`purge-${name}`);
    const createdAt = isoDaysAgo(30);
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode,
        interaction_mode, created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, 'project-1', ${`Thread ${name}`}, 'codex', 'full-access',
        'default', ${createdAt}, ${deletedAt ?? createdAt}, ${deletedAt}, '{}'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_events (
        event_id, thread_id, event_type, occurred_at, payload_json
      ) VALUES (${`evt-${name}`}, ${threadId}, 'thread.created', ${createdAt}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_command_receipts (
        command_id, thread_id, command_type, accepted_at, result_sequence, status
      ) VALUES (${`cmd-${name}`}, ${threadId}, 'thread.create', ${createdAt}, 1, 'accepted')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (${`run-${name}`}, ${threadId}, 1, 'codex', 'completed', ${createdAt}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES (${`msg-${name}`}, ${threadId}, 'user', 0, ${createdAt}, ${createdAt}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (${`item-${name}`}, ${threadId}, 1, 'message', 'completed', ${createdAt}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, provider, status, updated_at, payload_json
      ) VALUES (${`pt-${name}`}, ${threadId}, 'codex', 'idle', ${createdAt}, '{}')
    `;
    yield* sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
        last_run_status, run_count
      ) VALUES (
        ${`task-${name}`}, 'Standup', 'msg', 1, '{}', 'project-1', ${threadId},
        '{}', '{}', 'full-access', 'default', 'human', 'manual', ${createdAt}, ${createdAt},
        NULL, NULL, 'never', 0
      )
    `;
    return threadId;
  });

const seedBoard = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO ft3_board_orchestrators (thread_id, created_by, created_at) VALUES (${threadId}, 'human', ${isoDaysAgo(30)})`;
    yield* sql`INSERT INTO ft3_board_cards (card_id, orchestrator_thread_id, title, body, status, created_by, executor_role, failure_streak, order_index, archived, created_at, updated_at) VALUES (${`card-${threadId}`}, ${threadId}, 'Task', 'Body', 'done', 'orchestrator', 'implementation', 0, 0, 1, ${isoDaysAgo(30)}, ${isoDaysAgo(30)})`;
  });

layer("DeletedThreadPurge", (it) => {
  it.effect("erases a thread deleted 15 days ago from every V2 and ft3 table", () =>
    Effect.gen(function* () {
      yield* runCoreMigrations();
      yield* runMigrations();
      yield* TestClock.setTime(NOW_MS);
      const old = yield* seedThread("old", isoDaysAgo(15));
      const live = yield* seedThread("live", null);
      yield* seedBoard(old);

      const counts = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });

      assert.strictEqual(counts.purgedThreads, 1);
      assert.strictEqual(counts.stoppedEarly, false);
      assert.deepStrictEqual(yield* countFor(old), zeroCounts);
      const liveCounts = yield* countFor(live);
      assert.strictEqual(liveCounts.threads, 1);
      assert.strictEqual(liveCounts.events, 1);
    }),
  );

  it.effect("treats the 14-day boundary as inclusive and selects by deleted_at", () =>
    Effect.gen(function* () {
      yield* runCoreMigrations();
      yield* runMigrations();
      yield* TestClock.setTime(NOW_MS);
      const exact = yield* seedThread("exact", isoDaysAgo(14));
      const young = yield* seedThread("young", isoDaysAgo(13));
      const sql = yield* SqlClient.SqlClient;
      const staleTouch = yield* seedThread("stale-touch", isoDaysAgo(20));
      yield* sql`UPDATE orchestration_v2_projection_threads SET updated_at = ${isoDaysAgo(2)} WHERE thread_id = ${staleTouch}`;

      const candidates = yield* listDeletedThreadPurgeCandidates(cutoff14(), 100);
      assert.isTrue(candidates.some((candidate) => candidate.threadId === exact));
      assert.isFalse(candidates.some((candidate) => candidate.threadId === young));

      const counts = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });
      assert.strictEqual(counts.purgedThreads, 2);
      assert.deepStrictEqual(yield* countFor(exact), zeroCounts);
      assert.deepStrictEqual(yield* countFor(staleTouch), zeroCounts);
      assert.strictEqual((yield* countFor(young)).threads, 1);
    }),
  );

  it.effect("stops on budget exhaustion and resumes on the next pass", () =>
    Effect.gen(function* () {
      yield* runCoreMigrations();
      yield* runMigrations();
      yield* TestClock.setTime(NOW_MS);
      const first = yield* seedThread("budget-1", isoDaysAgo(15));
      const second = yield* seedThread("budget-2", isoDaysAgo(16));
      const third = yield* seedThread("budget-3", isoDaysAgo(17));
      const ticking = yield* Ref.make(0);
      const nowMs = Ref.updateAndGet(ticking, (tick) => tick + 10_000);

      const partial = yield* purgeDeletedThreads({
        cutoffIso: cutoff14(),
        budgetMs: 40_000,
        batchLimit: 10,
        nowMs,
      });

      assert.strictEqual(partial.stoppedEarly, true);
      assert.isAtLeast(partial.purgedThreads, 1);
      assert.isAtMost(partial.purgedThreads, 2);

      const survivors =
        Number((yield* countFor(first)).threads > 0) +
        Number((yield* countFor(second)).threads > 0) +
        Number((yield* countFor(third)).threads > 0);
      assert.isAtLeast(survivors, 1);

      const resumed = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });
      assert.strictEqual(resumed.stoppedEarly, false);
      assert.deepStrictEqual(yield* countFor(first), zeroCounts);
      assert.deepStrictEqual(yield* countFor(second), zeroCounts);
      assert.deepStrictEqual(yield* countFor(third), zeroCounts);
    }),
  );

  it.effect("rolls back a thread entirely when erasure fails midway", () =>
    Effect.gen(function* () {
      yield* runCoreMigrations();
      yield* runMigrations();
      yield* TestClock.setTime(NOW_MS);
      const sql = yield* SqlClient.SqlClient;
      const old = yield* seedThread("crash", isoDaysAgo(15));
      yield* sql`
        CREATE TRIGGER purge_test_fail
        BEFORE DELETE ON orchestration_v2_projection_messages
        BEGIN
          SELECT RAISE(ABORT, 'injected purge failure');
        END
      `;
      const failure = yield* Effect.flip(purgeDeletedThread(old));
      assert.isDefined(failure);
      const counts = yield* countFor(old);
      assert.strictEqual(counts.threads, 1);
      assert.strictEqual(counts.events, 1);
      assert.strictEqual(counts.messages, 1);
      yield* sql`DROP TRIGGER purge_test_fail`;
      yield* purgeDeletedThread(old);
      assert.deepStrictEqual(yield* countFor(old), zeroCounts);
    }),
  );

  it.effect("erases mail rows that reference a purged thread", () =>
    Effect.gen(function* () {
      yield* runCoreMigrations();
      yield* runMigrations();
      yield* TestClock.setTime(NOW_MS);
      yield* seedMailTask({
        taskId: "mail:lead-gone",
        lead: "thread:mail-lead",
        memberId: "mail:member-gone",
        participant: "thread:mail-participant",
        letterId: "mail:letter-gone",
        deliveryId: "mail:delivery-gone",
        wakeId: "mail:wake-gone",
        roundId: "mail:round-gone",
      });
      yield* seedMailTask({
        taskId: "mail:live",
        lead: "thread:mail-live",
        memberId: "mail:member-live",
        participant: "thread:mail-participant",
        letterId: "mail:letter-live",
        deliveryId: "mail:delivery-live",
        wakeId: "mail:wake-live",
        roundId: "mail:round-live",
      });
      yield* purgeDeletedThread(ThreadId.make("thread:mail-participant"));
      assert.strictEqual(
        yield* mailCount("ft3_mail_members", "participant_thread_id", "thread:mail-participant"),
        0,
      );
      assert.strictEqual(
        yield* mailCount("ft3_mail_wakes", "target_thread_id", "thread:mail-participant"),
        0,
      );
      assert.strictEqual(yield* mailCount("ft3_mail_tasks", "task_id", "mail:lead-gone"), 1);
      assert.strictEqual(yield* mailCount("ft3_mail_letters", "task_id", "mail:lead-gone"), 1);

      yield* purgeDeletedThread(ThreadId.make("thread:mail-lead"));
      assert.strictEqual(yield* mailCount("ft3_mail_tasks", "task_id", "mail:lead-gone"), 0);
      assert.strictEqual(yield* mailCount("ft3_mail_letters", "task_id", "mail:lead-gone"), 0);
      assert.strictEqual(yield* mailCount("ft3_mail_deliveries", "task_id", "mail:lead-gone"), 0);
      assert.strictEqual(yield* mailCount("ft3_mail_wakes", "task_id", "mail:lead-gone"), 0);
      assert.strictEqual(yield* mailCount("ft3_mail_rounds", "task_id", "mail:lead-gone"), 0);
      assert.strictEqual(yield* mailCount("ft3_mail_members", "task_id", "mail:lead-gone"), 0);

      assert.strictEqual(yield* mailCount("ft3_mail_tasks", "task_id", "mail:live"), 1);
      assert.strictEqual(yield* mailCount("ft3_mail_letters", "task_id", "mail:live"), 1);
    }),
  );
});

const seedMailTask = (input: {
  readonly taskId: string;
  readonly lead: string;
  readonly memberId: string;
  readonly participant: string;
  readonly letterId: string;
  readonly deliveryId: string;
  readonly wakeId: string;
  readonly roundId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO ft3_mail_tasks (task_id, title, brief, level, status, created_by_thread_id, client_request_id, request_fingerprint, created_at, updated_at) VALUES (${input.taskId}, 'Refactor', 'Split the module.', 'medium', 'open', ${input.lead}, ${`mail:task:${input.taskId}`}, ${`mail:task:${input.taskId}`}, ${isoDaysAgo(15)}, ${isoDaysAgo(15)})`;
    yield* sql`INSERT INTO ft3_mail_members (member_id, task_id, role_id, specialization, level, status, participant_thread_id, created_at, updated_at) VALUES (${input.memberId}, ${input.taskId}, 'implementation', NULL, 'medium', 'active', ${input.participant}, ${isoDaysAgo(15)}, ${isoDaysAgo(15)})`;
    yield* sql`INSERT INTO ft3_mail_letters (letter_id, task_id, sequence, sender_thread_id, recipient, kind, body, reply_to_letter_id, client_request_id, request_fingerprint, created_at) VALUES (${input.letterId}, ${input.taskId}, 1, ${input.lead}, ${`member:${input.memberId}`}, 'request', 'Start.', NULL, ${`mail:letter:${input.letterId}`}, ${`mail:letter:${input.letterId}`}, ${isoDaysAgo(15)})`;
    yield* sql`INSERT INTO ft3_mail_deliveries (delivery_id, task_id, letter_id, member_id, recipient, participant_thread_id, state, created_at, updated_at) VALUES (${input.deliveryId}, ${input.taskId}, ${input.letterId}, ${input.memberId}, ${`member:${input.memberId}`}, ${input.participant}, 'pending', ${isoDaysAgo(15)}, ${isoDaysAgo(15)})`;
    yield* sql`INSERT INTO ft3_mail_rounds (round_id, task_id, round_number, kind, opened_at) VALUES (${input.roundId}, ${input.taskId}, 1, 'review', ${isoDaysAgo(15)})`;
    yield* sql`INSERT INTO ft3_mail_wakes (wake_id, task_id, target_thread_id, reason, idempotency_key, created_at, delivered_at) VALUES (${input.wakeId}, ${input.taskId}, ${input.participant}, 'mail-letter', ${`mail:wake:${input.deliveryId}`}, ${isoDaysAgo(15)}, NULL)`;
  });

const mailCount = (table: string, column: string, value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total FROM ${sql.literal(table)} WHERE ${sql.literal(column)} = ${value}`;
    return rows[0]!.total;
  });
