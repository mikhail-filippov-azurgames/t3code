import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../ft3-host/src/Migrations.ts";

describe("architect migrations through ft3-host", () => {
  it.effect("creates the final legacy architect columns and indexes with V2 ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations();
      const bindingColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(ft3_architect_binding)`;
      assert.deepStrictEqual(
        bindingColumns.map((column) => column.name),
        [
          "binding_id",
          "coordinator_thread_id",
          "architect_thread_id",
          "project_id",
          "architect_task_effort",
          "status",
          "created_at",
          "created_by",
          "replaced_by_binding_id",
          "detach_reason",
          "create_idempotency_key",
          "create_request_fingerprint",
          "close_idempotency_key",
          "close_request_fingerprint",
          "routing_evidence_json",
        ],
      );
      const reviewColumns = yield* sql<{
        readonly name: string;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(ft3_architect_review)`;
      assert.deepStrictEqual(
        reviewColumns.map((column) => column.name),
        [
          "review_id",
          "binding_id",
          "coordinator_thread_id",
          "architect_thread_id",
          "subject_child_thread_id",
          "reason",
          "question",
          "refs_json",
          "execution_posture",
          "answer_disposition",
          "status",
          "answer_summary",
          "request_idempotency_key",
          "answer_idempotency_key",
          "answer_payload_fingerprint",
          "request_payload_fingerprint",
          "publish_idempotency_key",
          "cancel_idempotency_key",
          "cancel_payload_fingerprint",
          "cancelled_at",
          "cancelled_by",
          "created_at",
          "answered_at",
          "published_at",
          "publish_delivered_at",
          "last_publish_failure_reason",
          "last_publish_failure_message",
          "last_publish_failure_at",
          "origin",
          "published_by",
          "request_wake_delivered_at",
        ],
      );
      assert.equal(
        reviewColumns.find((column) => column.name === "origin")!.dflt_value,
        "'coordinator-request'",
      );
      const bindingFk = yield* sql<{ readonly table: string; readonly on_delete: string }>`
        PRAGMA foreign_key_list(ft3_architect_binding)
      `;
      assert.equal(bindingFk[0]!.table, "orchestration_v2_projection_threads");
      assert.equal(bindingFk[0]!.on_delete, "CASCADE");
      const reviewFk = yield* sql<{ readonly table: string; readonly on_delete: string }>`
        PRAGMA foreign_key_list(ft3_architect_review)
      `;
      assert.equal(reviewFk[0]!.table, "ft3_architect_binding");
      assert.equal(reviewFk[0]!.on_delete, "CASCADE");
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_ft3_architect_%' ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        [
          "idx_ft3_architect_binding_active_architect",
          "idx_ft3_architect_binding_active_coordinator",
          "idx_ft3_architect_binding_idempotency",
          "idx_ft3_architect_review_binding",
          "idx_ft3_architect_review_coordinator_status",
          "idx_ft3_architect_review_request_idempotency",
          "idx_ft3_architect_review_unpublished_advice",
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is idempotent and preserves seeded bindings and reviews on rerun", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations();
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id) VALUES ('thread:coord'), ('thread:arch')`;
      yield* sql`INSERT INTO ft3_architect_binding (binding_id, coordinator_thread_id, architect_thread_id, project_id, architect_task_effort, status, created_at, created_by, create_idempotency_key, create_request_fingerprint, routing_evidence_json) VALUES ('binding:1', 'thread:coord', 'thread:arch', 'project:p', 'medium', 'active', '2026-01-01', 'thread:coord', 'key:1', 'fp:1', NULL)`;
      yield* sql`INSERT INTO ft3_architect_review (review_id, binding_id, coordinator_thread_id, architect_thread_id, reason, question, refs_json, execution_posture, status, request_idempotency_key, created_at) VALUES ('review:1', 'binding:1', 'thread:coord', 'thread:arch', 'direct-advice', 'question', '{}', 'continue', 'open', 'req:1', '2026-01-01')`;
      const bindingBefore = yield* sql`SELECT * FROM ft3_architect_binding`;
      const reviewBefore = yield* sql`SELECT * FROM ft3_architect_review`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_architect_binding`, bindingBefore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_architect_review`, reviewBefore);
      assert.equal(
        (yield* sql`SELECT origin FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!
          .origin,
        "coordinator-request",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back a partially applied architect migration and retries after conflict", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ft3_architect_binding (probe TEXT)`;
      yield* sql`INSERT INTO ft3_architect_binding VALUES ('retained')`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_architect_binding`, [
        { probe: "retained" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_schema WHERE name = 'ft3_architect_review'`,
        [],
      );
      assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM ft3_migrations`, []);
      yield* sql`DROP TABLE ft3_architect_binding`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [1, "Ft3Meta"],
        [2, "Board"],
        [3, "BoardReactor"],
        [4, "Architect"],
        [5, "ArchitectReviewWake"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
