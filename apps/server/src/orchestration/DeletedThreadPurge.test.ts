// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  deletedThreadPurgeCutoffIso,
  listDeletedThreadPurgeCandidates,
  purgeDeletedThread,
  purgeDeletedThreads,
} from "./DeletedThreadPurge.ts";

const layer = it.layer(SqlitePersistenceMemory);

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
  readonly activities: number;
  readonly turns: number;
  readonly sessions: number;
  readonly approvals: number;
  readonly plans: number;
  readonly pullRequests: number;
  readonly diffBlobs: number;
  readonly providerRuntime: number;
  readonly sendQueue: number;
  readonly taskSummaries: number;
  readonly calendarEvents: number;
  readonly reviews: number;
  readonly bindings: number;
  readonly orchestrators: number;
  readonly cards: number;
}

/** Row counts for one thread across every §2.2 table (plus board cards). */
const countFor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<TableCounts>`
      SELECT
        (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${threadId}) AS "threads",
        (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}) AS "events",
        (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}) AS "receipts",
        (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) AS "messages",
        (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) AS "activities",
        (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${threadId}) AS "turns",
        (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${threadId}) AS "sessions",
        (SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ${threadId}) AS "approvals",
        (SELECT COUNT(*) FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}) AS "plans",
        (SELECT COUNT(*) FROM projection_thread_pull_requests WHERE thread_id = ${threadId}) AS "pullRequests",
        (SELECT COUNT(*) FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}) AS "diffBlobs",
        (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${threadId}) AS "providerRuntime",
        (SELECT COUNT(*) FROM delegated_turn_send_queue WHERE thread_id = ${threadId}) AS "sendQueue",
        (SELECT COUNT(*) FROM projection_delegated_task_summaries WHERE child_thread_id = ${threadId} OR parent_thread_id = ${threadId}) AS "taskSummaries",
        (SELECT COUNT(*) FROM calendar_events WHERE thread_id = ${threadId}) AS "calendarEvents",
        (SELECT COUNT(*) FROM architecture_review WHERE coordinator_thread_id = ${threadId} OR architect_thread_id = ${threadId}) AS "reviews",
        (SELECT COUNT(*) FROM coordinator_architect_binding WHERE coordinator_thread_id = ${threadId} OR architect_thread_id = ${threadId}) AS "bindings",
        (SELECT COUNT(*) FROM board_orchestrators WHERE thread_id = ${threadId}) AS "orchestrators",
        (SELECT COUNT(*) FROM board_cards WHERE orchestrator_thread_id = ${threadId}) AS "cards"
    `;
    return rows[0] as TableCounts;
  });

const zeroCounts: TableCounts = {
  threads: 0,
  events: 0,
  receipts: 0,
  messages: 0,
  activities: 0,
  turns: 0,
  sessions: 0,
  approvals: 0,
  plans: 0,
  pullRequests: 0,
  diffBlobs: 0,
  providerRuntime: 0,
  sendQueue: 0,
  taskSummaries: 0,
  calendarEvents: 0,
  reviews: 0,
  bindings: 0,
  orchestrators: 0,
  cards: 0,
};

interface SeedOptions {
  readonly deletedAt: string | null;
  readonly updatedAt?: string;
  readonly createdAt?: string;
}

/** One thread with exactly one row in every per-thread §2.2 table. */
const seedThread = (name: string, options: SeedOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make(`purge-${name}`);
    const createdAt = options.createdAt ?? isoDaysAgo(30);
    const updatedAt = options.updatedAt ?? options.deletedAt ?? createdAt;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        created_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, 'project-1', ${`Thread ${name}`},
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
        ${createdAt}, ${updatedAt}, ${options.deletedAt}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      ) VALUES
        (${`evt-${name}-created`}, 'thread', ${threadId}, 1, 'thread.created',
         ${createdAt}, 'human', '{}', '{}'),
        (${`evt-${name}-deleted`}, 'thread', ${threadId}, 2, 'thread.deleted',
         ${options.deletedAt ?? createdAt}, 'human', '{}', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at,
        result_sequence, status
      ) VALUES (
        ${`cmd-${name}`}, 'thread', ${threadId}, ${createdAt}, 1, 'accepted'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (
        ${`msg-${name}`}, ${threadId}, 'user', 'hello', 0, ${createdAt}, ${createdAt}
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, tone, kind, summary, payload_json, created_at
      ) VALUES (
        ${`act-${name}`}, ${threadId}, 'info', 'thread.created', 'created',
        '{}', ${createdAt}
      )
    `;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, state, requested_at, checkpoint_files_json
      ) VALUES (${threadId}, ${`turn-${name}`}, 'completed', ${createdAt}, '[]')
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
      VALUES (${threadId}, 'idle', ${createdAt})
    `;
    yield* sql`
      INSERT INTO projection_pending_approvals (
        request_id, thread_id, status, created_at
      ) VALUES (${`appr-${name}`}, ${threadId}, 'pending', ${createdAt})
    `;
    yield* sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id, thread_id, plan_markdown, created_at, updated_at
      ) VALUES (${`plan-${name}`}, ${threadId}, '# plan', ${createdAt}, ${createdAt})
    `;
    yield* sql`
      INSERT INTO projection_thread_pull_requests (
        thread_id, host, repository, number, url, source, linked_at
      ) VALUES (
        ${threadId}, 'github.com', 'acme/repo', 7,
        'https://example.invalid/pr/7', 'manual', ${createdAt}
      )
    `;
    yield* sql`
      INSERT INTO checkpoint_diff_blobs (
        thread_id, from_turn_count, to_turn_count, diff, created_at
      ) VALUES (${threadId}, 1, 2, 'diff', ${createdAt})
    `;
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, adapter_key, status, last_seen_at
      ) VALUES (${threadId}, 'codex', 'codex', 'idle', ${createdAt})
    `;
    yield* sql`
      INSERT INTO delegated_turn_send_queue (
        thread_id, message_id, request_sequence, state
      ) VALUES (${threadId}, ${`qmsg-${name}`}, 1, 'pending')
    `;
    yield* sql`
      INSERT INTO projection_delegated_task_summaries (
        child_thread_id, parent_environment_id, parent_thread_id,
        source_turn_id, completed_at, summary_text, source,
        source_turn_ids_json, watermark, content_fingerprint, state, updated_at
      ) VALUES (
        ${threadId}, 'env-1', 'parent-1', 'turn-1', ${createdAt}, 'summary',
        'test', '["turn-1"]', 1, 'fp', 'ready', ${createdAt}
      )
    `;
    yield* sql`
      INSERT INTO calendar_events (
        event_id, project_id, title, message, mode, cron_expression,
        time_zone, next_fire_at, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, thread_id
      ) VALUES (
        ${`cal-${name}`}, 'project-1', 'Standup', 'msg', 'continue',
        '0 9 * * *', 'UTC', ${createdAt},
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
        ${createdAt}, ${createdAt}, ${threadId}
      )
    `;
    return threadId;
  });

const seedBoard = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_orchestrators (thread_id, created_by, created_at)
      VALUES (${threadId}, 'human', ${isoDaysAgo(30)})
    `;
    yield* sql`
      INSERT INTO board_cards (
        card_id, orchestrator_thread_id, title, body, status, created_by,
        executor_role, failure_streak, order_index, archived, created_at, updated_at
      ) VALUES (
        ${`card-${threadId}`}, ${threadId}, 'Task', 'Body', 'done',
        'orchestrator', 'implementation', 0, 0, 0,
        ${isoDaysAgo(30)}, ${isoDaysAgo(30)}
      )
    `;
  });

const seedBinding = (coordinator: ThreadId, architect: ThreadId, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bindingId = `binding-${coordinator}`;
    yield* sql`
      INSERT INTO coordinator_architect_binding (
        binding_id, coordinator_thread_id, architect_thread_id, project_id,
        architect_task_effort, status, created_at, created_by,
        create_idempotency_key, create_request_fingerprint
      ) VALUES (
        ${bindingId}, ${coordinator}, ${architect}, 'project-1', 'high',
        ${status}, ${isoDaysAgo(30)}, 'human', ${`key-${coordinator}`},
        ${`fp-${coordinator}`}
      )
    `;
    yield* sql`
      INSERT INTO architecture_review (
        review_id, binding_id, coordinator_thread_id, architect_thread_id,
        reason, question, refs_json, execution_posture, status,
        request_idempotency_key, created_at
      ) VALUES (
        ${`review-${coordinator}`}, ${bindingId}, ${coordinator}, ${architect},
        'direct-advice', 'Ship it?', '[]', 'continue', 'open',
        ${`req-${coordinator}`}, ${isoDaysAgo(30)}
      )
    `;
  });

layer("DeletedThreadPurge", (it) => {
  it.effect("erases a thread deleted 15 days ago from every §2.2 table", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const old = yield* seedThread("old", { deletedAt: isoDaysAgo(15) });
      const liveArchitect = yield* seedThread("architect-live", { deletedAt: null });
      yield* seedBoard(old);
      yield* seedBinding(old, liveArchitect, "detached");

      const counts = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });

      assert.strictEqual(counts.purgedThreads, 1);
      assert.strictEqual(counts.purgedEvents, 2);
      assert.strictEqual(counts.stoppedEarly, false);
      assert.deepStrictEqual(yield* countFor(old), zeroCounts);
      // The live architect keeps its own rows, but the erased coordinator's
      // binding and review are gone with it.
      const architectCounts = yield* countFor(liveArchitect);
      assert.strictEqual(architectCounts.threads, 1);
      assert.strictEqual(architectCounts.events, 2);
      assert.strictEqual(architectCounts.bindings, 0);
      assert.strictEqual(architectCounts.reviews, 0);
    }),
  );

  it.effect("treats the 14-day boundary as inclusive", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const exact = yield* seedThread("exact", { deletedAt: isoDaysAgo(14) });
      const young = yield* seedThread("young", { deletedAt: isoDaysAgo(13) });

      const candidates = yield* listDeletedThreadPurgeCandidates(cutoff14(), 100);
      assert.isTrue(candidates.some((candidate) => candidate.threadId === exact));
      assert.isFalse(candidates.some((candidate) => candidate.threadId === young));

      const counts = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });
      assert.strictEqual(counts.purgedThreads, 1);
      assert.deepStrictEqual(yield* countFor(exact), zeroCounts);
      const youngCounts = yield* countFor(young);
      assert.strictEqual(youngCounts.threads, 1);
      assert.strictEqual(youngCounts.events, 2);
    }),
  );

  it.effect("selects by deleted_at, never by updated_at", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const sql = yield* SqlClient.SqlClient;
      // Deleted 20 days ago but touched 2 days ago: still due.
      const staleTouch = yield* seedThread("stale-touch", {
        deletedAt: isoDaysAgo(20),
        updatedAt: isoDaysAgo(2),
      });
      const fresh = yield* seedThread("fresh", { deletedAt: isoDaysAgo(2) });
      const live = yield* seedThread("live", { deletedAt: null });
      const archived = yield* seedThread("archived", { deletedAt: null });
      yield* sql`
        UPDATE projection_threads
        SET archived_at = ${isoDaysAgo(40)}
        WHERE thread_id = ${archived}
      `;

      const counts = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });

      assert.strictEqual(counts.purgedThreads, 1);
      assert.deepStrictEqual(yield* countFor(staleTouch), zeroCounts);
      for (const survivor of [fresh, live, archived]) {
        const survivorCounts = yield* countFor(survivor);
        assert.strictEqual(survivorCounts.threads, 1);
        assert.strictEqual(survivorCounts.events, 2);
      }
    }),
  );

  it.effect("nulls live references instead of deleting live rows", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const sql = yield* SqlClient.SqlClient;
      const old = yield* seedThread("ref-old", { deletedAt: isoDaysAgo(15) });
      const live = yield* seedThread("ref-live", { deletedAt: null });
      const other = yield* seedThread("ref-other", { deletedAt: null });
      yield* sql`
        UPDATE projection_thread_proposed_plans
        SET implementation_thread_id = ${old}
        WHERE thread_id = ${live}
      `;
      yield* sql`
        UPDATE projection_turns
        SET source_proposed_plan_thread_id = ${old}
        WHERE thread_id = ${live}
      `;
      yield* sql`
        INSERT INTO projection_delegated_task_summaries (
          child_thread_id, parent_environment_id, parent_thread_id,
          source_turn_id, completed_at, summary_text, source,
          source_turn_ids_json, watermark, content_fingerprint, state, updated_at
        ) VALUES (
          ${other}, 'env-1', ${old}, 'turn-9', ${isoDaysAgo(30)},
          'summary', 'test', '["turn-9"]', 1, 'fp', 'ready', ${isoDaysAgo(30)}
        )
      `;

      yield* purgeDeletedThreads({ cutoffIso: cutoff14() });

      assert.deepStrictEqual(yield* countFor(old), zeroCounts);
      const liveCounts = yield* countFor(live);
      assert.strictEqual(liveCounts.threads, 1);
      assert.strictEqual(liveCounts.plans, 1);
      assert.strictEqual(liveCounts.turns, 1);
      assert.strictEqual(liveCounts.taskSummaries, 1);
      const links = yield* sql<{
        readonly implementationThreadId: string | null;
        readonly sourceThreadId: string | null;
      }>`
        SELECT
          (SELECT implementation_thread_id FROM projection_thread_proposed_plans WHERE thread_id = ${live}) AS "implementationThreadId",
          (SELECT source_proposed_plan_thread_id FROM projection_turns WHERE thread_id = ${live}) AS "sourceThreadId"
      `;
      assert.isNull(links[0]?.implementationThreadId);
      assert.isNull(links[0]?.sourceThreadId);
      // The parent-side summary is gone, but the other child's own rows stay.
      const otherCounts = yield* countFor(other);
      assert.strictEqual(otherCounts.threads, 1);
      assert.strictEqual(otherCounts.taskSummaries, 1);
      const parentSide = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_delegated_task_summaries
        WHERE parent_thread_id = ${old}
      `;
      assert.strictEqual(parentSide[0]?.count, 0);
    }),
  );

  it.effect("keeps an architect binding while its coordinator lives", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const coordinator = yield* seedThread("coord-live", { deletedAt: null });
      const architect = yield* seedThread("arch-old", { deletedAt: isoDaysAgo(15) });
      yield* seedBinding(coordinator, architect, "detached");

      yield* purgeDeletedThreads({ cutoffIso: cutoff14() });

      // The architect's own rows are gone, but the audit binding stays.
      const architectCounts = yield* countFor(architect);
      assert.strictEqual(architectCounts.threads, 0);
      assert.strictEqual(architectCounts.events, 0);
      assert.strictEqual(architectCounts.bindings, 1);
      assert.strictEqual(architectCounts.reviews, 1);
      const coordinatorCounts = yield* countFor(coordinator);
      assert.strictEqual(coordinatorCounts.threads, 1);
      assert.strictEqual(coordinatorCounts.bindings, 1);
      assert.strictEqual(coordinatorCounts.reviews, 1);
    }),
  );

  it.effect("leaves worktrees, provider data, and reruns alone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const sql = yield* SqlClient.SqlClient;
      const old = yield* seedThread("disk-old", { deletedAt: isoDaysAgo(15) });
      const live = yield* seedThread("disk-live", { deletedAt: null });
      yield* sql`
        UPDATE projection_threads
        SET worktree_path = '/tmp/purge-worktree', branch = 'feature/purge'
        WHERE thread_id = ${live}
      `;
      // A retention proof for an unrelated card must survive the pass.
      yield* sql`
        INSERT INTO board_card_deletions (
          card_id, orchestrator_thread_id, deleted_at, reason, history_event_count
        ) VALUES (
          'other-card', 'other-orchestrator', ${isoDaysAgo(30)}, 'retention', 3
        )
      `;
      // The purge is SQL-only: a stand-in for an on-disk worktree survives.
      const worktreeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "purge-wt-"));
      const canary = NodePath.join(worktreeDir, "uncommitted.txt");
      NodeFS.writeFileSync(canary, "unsaved work");
      try {
        const first = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });
        assert.strictEqual(first.purgedThreads, 1);
        const second = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });
        assert.deepStrictEqual(second, {
          purgedThreads: 0,
          purgedEvents: 0,
          purgedRows: 0,
          stoppedEarly: false,
        });

        assert.deepStrictEqual(yield* countFor(old), zeroCounts);
        const liveRow = yield* sql<{
          readonly worktreePath: string | null;
          readonly branch: string | null;
        }>`
          SELECT worktree_path AS "worktreePath", branch
          FROM projection_threads
          WHERE thread_id = ${live}
        `;
        assert.strictEqual(liveRow[0]?.worktreePath, "/tmp/purge-worktree");
        assert.strictEqual(liveRow[0]?.branch, "feature/purge");
        const liveCounts = yield* countFor(live);
        assert.strictEqual(liveCounts.providerRuntime, 1);
        const proofs = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM board_card_deletions
          WHERE card_id = 'other-card'
        `;
        assert.strictEqual(proofs[0]?.count, 1);
        assert.strictEqual(NodeFS.readFileSync(canary, "utf8"), "unsaved work");
      } finally {
        NodeFS.rmSync(worktreeDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("stops on budget exhaustion and resumes on the next pass", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const first = yield* seedThread("budget-1", { deletedAt: isoDaysAgo(15) });
      const second = yield* seedThread("budget-2", { deletedAt: isoDaysAgo(16) });
      const third = yield* seedThread("budget-3", { deletedAt: isoDaysAgo(17) });
      // +10s per clock read: start, batch check, then one check per thread.
      // The second thread's check reaches the 30s budget, so exactly one
      // thread is erased before the pass stops.
      const ticking = yield* Ref.make(0);
      const nowMs = Ref.updateAndGet(ticking, (tick) => tick + 10_000);

      const partial = yield* purgeDeletedThreads({
        cutoffIso: cutoff14(),
        budgetMs: 30_000,
        batchLimit: 10,
        nowMs,
      });

      assert.strictEqual(partial.stoppedEarly, true);
      assert.strictEqual(partial.purgedThreads, 1);
      // Oldest first: budget-3 (17 days) is erased, the rest are untouched.
      assert.deepStrictEqual(yield* countFor(third), zeroCounts);
      assert.strictEqual((yield* countFor(first)).threads, 1);
      assert.strictEqual((yield* countFor(second)).threads, 1);

      const resumed = yield* purgeDeletedThreads({ cutoffIso: cutoff14() });
      assert.strictEqual(resumed.stoppedEarly, false);
      assert.strictEqual(resumed.purgedThreads, 2);
      assert.deepStrictEqual(yield* countFor(first), zeroCounts);
      assert.deepStrictEqual(yield* countFor(second), zeroCounts);
    }),
  );

  it.effect("rolls back a thread entirely when erasure fails midway", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const sql = yield* SqlClient.SqlClient;
      const old = yield* seedThread("crash", { deletedAt: isoDaysAgo(15) });
      yield* sql`
        CREATE TRIGGER purge_test_fail
        BEFORE DELETE ON projection_turns
        BEGIN
          SELECT RAISE(ABORT, 'injected purge failure');
        END
      `;
      try {
        const failure = yield* Effect.flip(purgeDeletedThread(old));
        assert.isDefined(failure);
        // Nothing was erased: the thread row, its events, and the rows the
        // pass deletes before reaching turns are all still there.
        const counts = yield* countFor(old);
        assert.strictEqual(counts.threads, 1);
        assert.strictEqual(counts.events, 2);
        assert.strictEqual(counts.turns, 1);
        assert.strictEqual(counts.plans, 1);
        assert.strictEqual(counts.messages, 1);
      } finally {
        yield* sql`DROP TRIGGER purge_test_fail`;
      }
      const recovered = yield* purgeDeletedThread(old);
      assert.strictEqual(recovered.events, 2);
      assert.deepStrictEqual(yield* countFor(old), zeroCounts);
    }),
  );
});
