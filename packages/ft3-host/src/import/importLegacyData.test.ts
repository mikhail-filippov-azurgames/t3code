import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  FALLBACK_DRIVER_KIND,
  FALLBACK_PROVIDER_INSTANCE_ID,
  LIVE_DATABASE_PATH,
  SUBAGENT_ID_PREFIX,
  STAGING_TABLE,
  importLegacyData,
  importLegacyDataSql,
  isLiveDatabasePath,
} from "./importLegacyData.ts";
import { LiveDatabaseRefusedError } from "./prepareLegacyDatabase.ts";

const PARENT = "thread:parent";
const CHILD_A = "thread:child-a";
const CHILD_B = "thread:child-b";
const BOARD_THREAD = "thread:board";
const ARCH_COORD = "thread:arch-coord";
const ARCH_ARCH = "thread:arch-arch";
const IMPORTED_COORDINATOR = "a20e700e-331a-4f93-bc85-a7a7800fc149";
const IMPORTED_CHILD = "delegated-task:ed72f885689c1769ad2f71b9897ddb0562f7ce1d";
const IMPORTED_NESTED_CHILD = "delegated-task:e2b70996c46609d4aea1ff887b625bc04229348c";

const createTargetSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      parent_node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      driver TEXT,
      provider_instance_id TEXT,
      provider_thread_id TEXT,
      child_thread_id TEXT,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      schedule_json TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      workspace_strategy_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      created_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT NOT NULL,
      last_run_error TEXT,
      run_count INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE ft3_board_orchestrators (
      thread_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE ft3_board_cards (
      card_id TEXT PRIMARY KEY,
      orchestrator_thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      assignee_json TEXT,
      executor_role TEXT NOT NULL,
      executor_thread_id TEXT,
      outcome TEXT,
      last_error TEXT,
      failure_streak INTEGER NOT NULL,
      order_index INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      readiness TEXT NOT NULL DEFAULT 'ready',
      readiness_note TEXT
    )`;
    yield* sql`CREATE TABLE ft3_board_card_events (
      entry_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      at TEXT NOT NULL,
      status TEXT NOT NULL,
      executor_role TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      body TEXT,
      source TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE ft3_board_card_deletions (
      card_id TEXT PRIMARY KEY,
      orchestrator_thread_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      history_event_count INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE ft3_architect_binding (
      binding_id TEXT PRIMARY KEY,
      coordinator_thread_id TEXT NOT NULL,
      architect_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      architect_task_effort TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      replaced_by_binding_id TEXT,
      detach_reason TEXT,
      create_idempotency_key TEXT NOT NULL,
      create_request_fingerprint TEXT NOT NULL,
      close_idempotency_key TEXT,
      close_request_fingerprint TEXT,
      routing_evidence_json TEXT
    )`;
    yield* sql`CREATE TABLE ft3_architect_review (
      review_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      coordinator_thread_id TEXT NOT NULL,
      architect_thread_id TEXT NOT NULL,
      subject_child_thread_id TEXT,
      reason TEXT NOT NULL,
      question TEXT NOT NULL,
      refs_json TEXT NOT NULL,
      execution_posture TEXT NOT NULL,
      answer_disposition TEXT,
      status TEXT NOT NULL,
      answer_summary TEXT,
      request_idempotency_key TEXT NOT NULL,
      answer_idempotency_key TEXT,
      answer_payload_fingerprint TEXT,
      request_payload_fingerprint TEXT,
      publish_idempotency_key TEXT,
      cancel_idempotency_key TEXT,
      cancel_payload_fingerprint TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      published_at TEXT,
      publish_delivered_at TEXT,
      last_publish_failure_reason TEXT,
      last_publish_failure_message TEXT,
      last_publish_failure_at TEXT,
      origin TEXT NOT NULL DEFAULT 'coordinator-request',
      published_by TEXT
    )`;
    yield* sql`CREATE TABLE ft3_delegated_task_summaries (
      child_thread_id TEXT NOT NULL,
      parent_environment_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      source TEXT NOT NULL,
      source_turn_ids_json TEXT NOT NULL,
      watermark INTEGER NOT NULL,
      content_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_after TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (child_thread_id, source_turn_id)
    )`;
  });

const createSourceSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE board_orchestrators (
      thread_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`;
    yield* sql`CREATE TABLE board_cards (
      card_id TEXT PRIMARY KEY, orchestrator_thread_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, assignee_json TEXT,
      executor_role TEXT NOT NULL, executor_thread_id TEXT, outcome TEXT, last_error TEXT,
      failure_streak INTEGER NOT NULL, order_index INTEGER NOT NULL, archived INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, readiness TEXT NOT NULL DEFAULT 'ready',
      readiness_note TEXT)`;
    yield* sql`CREATE TABLE board_card_events (
      entry_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL,
      executor_role TEXT NOT NULL, model TEXT, effort TEXT, body TEXT, source TEXT NOT NULL)`;
    yield* sql`CREATE TABLE board_card_deletions (
      card_id TEXT PRIMARY KEY, orchestrator_thread_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL, history_event_count INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE coordinator_architect_binding (
      binding_id TEXT PRIMARY KEY, coordinator_thread_id TEXT NOT NULL, architect_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL, architect_task_effort TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, replaced_by_binding_id TEXT,
      detach_reason TEXT, create_idempotency_key TEXT NOT NULL, create_request_fingerprint TEXT NOT NULL,
      close_idempotency_key TEXT, close_request_fingerprint TEXT, routing_evidence_json TEXT)`;
    yield* sql`CREATE TABLE architecture_review (
      review_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, coordinator_thread_id TEXT NOT NULL,
      architect_thread_id TEXT NOT NULL, subject_child_thread_id TEXT, reason TEXT NOT NULL,
      question TEXT NOT NULL, refs_json TEXT NOT NULL, execution_posture TEXT NOT NULL,
      answer_disposition TEXT, status TEXT NOT NULL, answer_summary TEXT,
      request_idempotency_key TEXT NOT NULL, answer_idempotency_key TEXT,
      answer_payload_fingerprint TEXT, publish_idempotency_key TEXT, cancel_idempotency_key TEXT,
      cancel_payload_fingerprint TEXT, cancelled_at TEXT, cancelled_by TEXT, created_at TEXT NOT NULL,
      answered_at TEXT, published_at TEXT, request_payload_fingerprint TEXT, publish_delivered_at TEXT,
      last_publish_failure_reason TEXT, last_publish_failure_message TEXT, last_publish_failure_at TEXT,
      origin TEXT NOT NULL DEFAULT 'coordinator-request', published_by TEXT)`;
    yield* sql`CREATE TABLE projection_delegated_task_summaries (
      child_thread_id TEXT NOT NULL, parent_environment_id TEXT NOT NULL, parent_thread_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL, completed_at TEXT NOT NULL, summary_text TEXT NOT NULL,
      source TEXT NOT NULL, source_turn_ids_json TEXT NOT NULL, watermark INTEGER NOT NULL,
      content_fingerprint TEXT NOT NULL, state TEXT NOT NULL, error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, retry_after TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (child_thread_id, source_turn_id))`;
    yield* sql`CREATE TABLE calendar_events (
      event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
      mode TEXT NOT NULL, cron_expression TEXT NOT NULL, time_zone TEXT NOT NULL,
      next_fire_at TEXT NOT NULL, last_fired_at TEXT, last_missed_at TEXT, thread_id TEXT,
      model_selection_json TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    yield* sql`CREATE TABLE ft3_delegation_lineage_staging (
      thread_id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  });

const threadPayload = (parent: string | null, relationship: string | null) =>
  JSON.stringify({
    lineage: { parentThreadId: parent, relationshipToParent: relationship, rootThreadId: PARENT },
  });

const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, payload_json) VALUES
      (${PARENT}, 'project:1', 'Parent', ${threadPayload(null, null)}),
      (${CHILD_A}, 'project:1', 'Child A', ${JSON.stringify({ lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: CHILD_A } })}),
      (${CHILD_B}, 'project:1', 'Child B', ${JSON.stringify({ lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: CHILD_B } })}),
      (${BOARD_THREAD}, 'project:1', 'Board', ${threadPayload(null, null)}),
      (${ARCH_COORD}, 'project:1', 'Coord', ${threadPayload(null, null)}),
      (${ARCH_ARCH}, 'project:1', 'Arch', ${threadPayload(null, null)})`;

    yield* sql`INSERT INTO board_orchestrators (thread_id, created_by, created_at) VALUES
      (${BOARD_THREAD}, 'human', '2026-09-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO board_cards (
        card_id, orchestrator_thread_id, title, body, status, created_by, assignee_json,
        executor_role, executor_thread_id, outcome, last_error, failure_streak, order_index,
        archived, created_at, updated_at, readiness, readiness_note
      ) VALUES
      ('card-1', ${BOARD_THREAD}, 'Card', 'body', 'todo', 'human', '{"role":"implementation"}',
        'implementation', NULL, NULL, NULL, 0, 0, 0, '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z', 'ready', NULL)`;
    yield* sql`INSERT INTO board_card_events (
        entry_id, card_id, at, status, executor_role, model, effort, body, source
      ) VALUES ('evt-1', 'card-1', '2026-09-01T00:00:00.000Z', 'todo', 'implementation', NULL, NULL, NULL, 'created')`;
    yield* sql`INSERT INTO board_card_deletions (
        card_id, orchestrator_thread_id, deleted_at, reason, history_event_count
      ) VALUES ('gone-1', ${BOARD_THREAD}, '2026-09-02T00:00:00.000Z', 'retention', 3)`;

    yield* sql`INSERT INTO coordinator_architect_binding (
        binding_id, coordinator_thread_id, architect_thread_id, project_id, architect_task_effort,
        status, created_at, created_by, replaced_by_binding_id, detach_reason,
        create_idempotency_key, create_request_fingerprint, close_idempotency_key,
        close_request_fingerprint, routing_evidence_json
      ) VALUES ('bind-1', ${ARCH_COORD}, ${ARCH_ARCH}, 'project:1', 'medium', 'active',
        '2026-09-01T00:00:00.000Z', 'human', NULL, NULL, 'idem-1', 'fp-1', NULL, NULL, '{"reason":"live"}')`;
    yield* sql`INSERT INTO architecture_review (
        review_id, binding_id, coordinator_thread_id, architect_thread_id, subject_child_thread_id,
        reason, question, refs_json, execution_posture, answer_disposition, status, answer_summary,
        request_idempotency_key, answer_idempotency_key, answer_payload_fingerprint,
        publish_idempotency_key, cancel_idempotency_key, cancel_payload_fingerprint, cancelled_at,
        cancelled_by, created_at, answered_at, published_at, request_payload_fingerprint,
        publish_delivered_at, last_publish_failure_reason, last_publish_failure_message,
        last_publish_failure_at, origin, published_by
      ) VALUES ('rev-1', 'bind-1', ${ARCH_COORD}, ${ARCH_ARCH}, ${CHILD_A}, 'why', 'q?', '[]',
        'eager', NULL, 'requested', NULL, 'idem-r1', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '2026-09-01T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'coordinator-request', NULL)`;

    yield* sql`INSERT INTO projection_delegated_task_summaries (
        child_thread_id, parent_environment_id, parent_thread_id, source_turn_id, completed_at,
        summary_text, source, source_turn_ids_json, watermark, content_fingerprint, state, error,
        attempt_count, retry_after, updated_at
      ) VALUES (${CHILD_A}, 'env-1', ${PARENT}, 'turn-1', '2026-09-05T00:00:00.000Z', 'Done.', 'model',
        '["turn-1"]', 1, 'fp-sum', 'ready', NULL, 0, NULL, '2026-09-05T00:00:00.000Z')`;

    yield* sql`INSERT INTO calendar_events (
        event_id, project_id, title, message, mode, cron_expression, time_zone, next_fire_at,
        last_fired_at, last_missed_at, thread_id, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES
      ('cal-1', 'project:1', 'Evening', 'Run evening', 'continue', '45 16 * * *', 'Europe/Moscow',
        '2026-10-26T16:45:00.000Z', NULL, NULL, ${PARENT}, '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', 'default', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
      ('cal-2', 'project:1', 'Noon', 'Run noon', 'continue', '0 14 * * *', 'Europe/Moscow',
        '2026-10-27T14:00:00.000Z', '2026-10-26T14:00:00.000Z', NULL, ${PARENT},
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;

    yield* sql`INSERT INTO ft3_delegation_lineage_staging (thread_id, created_at, payload_json) VALUES
      (${CHILD_A}, '2026-09-01T00:00:00.000Z',
        ${JSON.stringify({
          version: 1,
          taskId: CHILD_A,
          parentThreadId: PARENT,
          childThreadId: CHILD_A,
          requestedAt: "2026-09-01T00:00:00.000Z",
          requested: { providerInstanceId: "codex", driverKind: "native", model: "gpt-5" },
          role: "implementation",
          handoff: { contractRef: "c1", stage: "s1" },
          evidenceRefs: ["e1"],
          childCaps: ["orchestration"],
        })}),
      (${CHILD_B}, '2026-09-01T00:00:00.000Z',
        ${JSON.stringify({
          version: 1,
          taskId: CHILD_B,
          parentThreadId: PARENT,
          childThreadId: CHILD_B,
          requested: { providerInstanceId: "codex", driverKind: "native", model: "gpt-5" },
          role: "research",
        })}),
      ('thread:missing', '2026-09-01T00:00:00.000Z',
        ${JSON.stringify({
          version: 1,
          taskId: "thread:missing",
          parentThreadId: "thread:gone",
          childThreadId: "thread:missing",
        })})`;
  });

describe("importLegacyData", () => {
  it.effect("restores the family root for imported V1 delegated threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createTargetSchema(sql);
      yield* createSourceSchema(sql);
      yield* sql`INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, payload_json
      ) VALUES
        (${IMPORTED_COORDINATOR}, 'project:1', 'Coordinator', ${JSON.stringify({
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: IMPORTED_COORDINATOR,
          },
        })}),
        (${IMPORTED_CHILD}, 'project:1', 'Imported child', ${JSON.stringify({
          historyOrigin: "v1_import",
          modelSelection: {
            providerInstanceId: "opencode",
            model: "opencode-go/deepseek-v4.1-flash",
          },
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: IMPORTED_CHILD,
          },
        })}),
        (${IMPORTED_NESTED_CHILD}, 'project:1', 'Imported nested child', ${JSON.stringify({
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: IMPORTED_NESTED_CHILD,
          },
        })})`;
      yield* sql`INSERT INTO ${sql(STAGING_TABLE)} (thread_id, created_at, payload_json) VALUES
        (${IMPORTED_CHILD}, '2026-10-13T09:40:30.685Z', ${JSON.stringify({
          parentThreadId: IMPORTED_COORDINATOR,
          childThreadId: IMPORTED_CHILD,
        })}),
        (${IMPORTED_NESTED_CHILD}, '2026-10-13T09:40:31.095Z', ${JSON.stringify({
          parentThreadId: IMPORTED_CHILD,
          childThreadId: IMPORTED_NESTED_CHILD,
        })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status,
        started_at, completed_at, updated_at, payload_json, driver, provider_instance_id
      ) VALUES
        (${SUBAGENT_ID_PREFIX + IMPORTED_CHILD}, ${IMPORTED_COORDINATOR},
          ${`ft3:node:${IMPORTED_CHILD}`}, 'opencode', ${IMPORTED_CHILD}, 'app_owned', 'completed',
          '2026-10-13T09:40:30.685Z', NULL, '2026-10-13T09:40:30.685Z',
          ${JSON.stringify({ childThreadId: IMPORTED_CHILD })}, 'opencode', 'opencode'),
        (${SUBAGENT_ID_PREFIX + IMPORTED_NESTED_CHILD}, ${IMPORTED_CHILD},
          ${`ft3:node:${IMPORTED_NESTED_CHILD}`}, 'opencode', ${IMPORTED_NESTED_CHILD},
          'app_owned', 'completed', '2026-10-13T09:40:31.095Z', NULL,
          '2026-10-13T09:40:31.095Z', ${JSON.stringify({ childThreadId: IMPORTED_NESTED_CHILD })},
          'opencode', 'opencode')`;

      const result = yield* importLegacyDataSql();
      assert.strictEqual(result.lineageRestored, 2);
      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id IN (${IMPORTED_CHILD}, ${IMPORTED_NESTED_CHILD})
        ORDER BY thread_id`;
      const lineageByThread = new Map(
        rows.map((row) => [
          row.thread_id,
          JSON.parse(row.payload_json) as {
            readonly historyOrigin: string;
            readonly modelSelection?: {
              readonly providerInstanceId: string;
              readonly model: string;
            };
            readonly lineage: {
              readonly parentThreadId: string;
              readonly relationshipToParent: string;
              readonly rootThreadId: string;
            };
          },
        ]),
      );
      assert.deepStrictEqual(lineageByThread.get(IMPORTED_CHILD), {
        historyOrigin: "v1_import",
        modelSelection: {
          providerInstanceId: "opencode",
          model: "opencode-go/deepseek-v4.1-flash",
        },
        lineage: {
          parentThreadId: IMPORTED_COORDINATOR,
          relationshipToParent: "subagent",
          rootThreadId: IMPORTED_COORDINATOR,
        },
      });
      assert.deepStrictEqual(lineageByThread.get(IMPORTED_NESTED_CHILD), {
        historyOrigin: "v1_import",
        lineage: {
          parentThreadId: IMPORTED_CHILD,
          relationshipToParent: "subagent",
          rootThreadId: IMPORTED_COORDINATOR,
        },
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("copies legacy tables and builds subagents, lineage and scheduled tasks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createTargetSchema(sql);
      yield* createSourceSchema(sql);
      yield* seed(sql);

      const result = yield* importLegacyDataSql();

      assert.deepStrictEqual(result.boardOrchestrators, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.boardCards, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.boardCardEvents, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.boardCardDeletions, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.architectBindings, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.architectReviews, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.taskSummaries, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(result.scheduledTasks, { source: 2, target: 2, skipped: 0 });
      assert.deepStrictEqual(result.subagents, { source: 3, target: 2, skipped: 1 });
      assert.strictEqual(result.lineageRestored, 2);

      const readiness = yield* sql<{
        readonly readiness: string;
        readonly readiness_note: string | null;
      }>`
        SELECT readiness, readiness_note FROM ft3_board_cards WHERE card_id = 'card-1'`;
      assert.deepStrictEqual(readiness, [{ readiness: "ready", readiness_note: null }]);

      const binding = yield* sql<{ readonly routing_evidence_json: string }>`
        SELECT routing_evidence_json FROM ft3_architect_binding WHERE binding_id = 'bind-1'`;
      assert.strictEqual(binding[0]?.routing_evidence_json, '{"reason":"live"}');

      const schedules = yield* sql<{
        readonly task_id: string;
        readonly schedule_json: string;
        readonly created_by: string;
        readonly creation_source: string;
        readonly last_run_status: string;
      }>`
        SELECT task_id, schedule_json, created_by, creation_source, last_run_status
        FROM scheduled_tasks ORDER BY task_id`;
      assert.deepStrictEqual(schedules, [
        {
          task_id: "cal-1",
          schedule_json: '{"type":"fixed_time","timeOfDay":"16:45"}',
          created_by: "system",
          creation_source: "server",
          last_run_status: "never",
        },
        {
          task_id: "cal-2",
          schedule_json: '{"type":"fixed_time","timeOfDay":"14:00"}',
          created_by: "system",
          creation_source: "server",
          last_run_status: "succeeded",
        },
      ]);

      const subagent = yield* sql<{
        readonly payload_json: string;
        readonly origin: string;
        readonly status: string;
        readonly child_thread_id: string;
        readonly thread_id: string;
      }>`
        SELECT payload_json, origin, status, child_thread_id, thread_id
        FROM orchestration_v2_projection_subagents WHERE subagent_id = ${SUBAGENT_ID_PREFIX + CHILD_A}`;
      assert.strictEqual(subagent[0]?.origin, "app_owned");
      assert.strictEqual(subagent[0]?.status, "completed");
      assert.strictEqual(subagent[0]?.child_thread_id, CHILD_A);
      assert.strictEqual(subagent[0]?.thread_id, PARENT);
      const subagentPayload = JSON.parse(subagent[0]!.payload_json) as Record<string, unknown>;
      assert.strictEqual(subagentPayload.id, `${SUBAGENT_ID_PREFIX}${CHILD_A}`);
      assert.strictEqual(subagentPayload.providerInstanceId, "codex");
      assert.deepStrictEqual(subagentPayload.handoff, { contractRef: "c1", stage: "s1" });
      assert.deepStrictEqual(subagentPayload.evidenceRefs, ["e1"]);
      assert.deepStrictEqual(subagentPayload.childCaps, ["orchestration"]);

      const lineage = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${CHILD_A}`;
      const lineageJson = JSON.parse(lineage[0]!.payload_json) as {
        lineage: { parentThreadId: string | null; relationshipToParent: string | null };
      };
      assert.strictEqual(lineageJson.lineage.parentThreadId, PARENT);
      assert.strictEqual(lineageJson.lineage.relationshipToParent, "subagent");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is idempotent on repeated runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createTargetSchema(sql);
      yield* createSourceSchema(sql);
      yield* seed(sql);

      yield* importLegacyDataSql();
      const second = yield* importLegacyDataSql();

      assert.deepStrictEqual(second.boardOrchestrators, { source: 1, target: 1, skipped: 0 });
      assert.deepStrictEqual(second.subagents, { source: 3, target: 2, skipped: 1 });
      assert.strictEqual(second.lineageRestored, 2);
      const [count] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_subagents`;
      assert.strictEqual(count?.count, 2);
      const [tasks] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scheduled_tasks`;
      assert.strictEqual(tasks?.count, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses the live database path", () =>
    Effect.gen(function* () {
      const result = yield* importLegacyData(LIVE_DATABASE_PATH).pipe(
        Effect.catchTags({
          LiveDatabaseRefusedError: (error) => Effect.succeed(error.path),
        }),
      );
      assert.strictEqual(result, LIVE_DATABASE_PATH);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("flags only the live database path as live", () =>
    Effect.sync(() => {
      assert.isTrue(isLiveDatabasePath(LIVE_DATABASE_PATH));
      assert.isFalse(isLiveDatabasePath("C:\\Users\\User\\AppData\\Local\\Temp\\copy.sqlite"));
      assert.isFalse(isLiveDatabasePath("C:\\tmp\\copy\\state.sqlite"));
    }),
  );

  it.effect("synthesizes fallback provider values for a legacy payload without requested", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createTargetSchema(sql);
      yield* createSourceSchema(sql);
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, payload_json) VALUES
        (${PARENT}, 'project:1', 'Parent', ${threadPayload(null, null)}),
        (${CHILD_B}, 'project:1', 'Child B', ${JSON.stringify({ lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: CHILD_B } })})`;
      yield* sql`INSERT INTO ft3_delegation_lineage_staging (thread_id, created_at, payload_json) VALUES
        (${CHILD_B}, '2026-09-01T00:00:00.000Z', ${JSON.stringify({ parentThreadId: PARENT, childThreadId: CHILD_B })})`;

      const result = yield* importLegacyDataSql();

      assert.deepStrictEqual(result.subagents, { source: 1, target: 1, skipped: 0 });
      const row = yield* sql<{
        readonly payload_json: string;
        readonly provider: string;
        readonly driver: string | null;
      }>`
        SELECT payload_json, provider, driver FROM orchestration_v2_projection_subagents
        WHERE subagent_id = ${SUBAGENT_ID_PREFIX + CHILD_B}`;
      assert.strictEqual(row[0]?.provider, FALLBACK_PROVIDER_INSTANCE_ID);
      assert.strictEqual(row[0]?.driver, FALLBACK_DRIVER_KIND);
      const payload = JSON.parse(row[0]!.payload_json) as Record<string, unknown>;
      assert.strictEqual(payload.providerInstanceId, FALLBACK_PROVIDER_INSTANCE_ID);
      assert.strictEqual(payload.driver, FALLBACK_DRIVER_KIND);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
