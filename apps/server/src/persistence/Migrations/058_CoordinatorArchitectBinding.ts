import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Phase 1 Coordinator/Architect split (§3).
 *
 * Two new tables, zero backfill (legacy threads open as coordinators with no
 * binding). `orchestratorThreadId` columns are NOT renamed. Soft-delete
 * access is computed from the binding lookup — no thread-table migration.
 * Wake delivery is proven by marker activities, not timestamp columns.
 * When empty the tables are inert, so no migration rollback is needed; a
 * down-migration would drop only these two tables.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS coordinator_architect_binding (
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
      close_idempotency_key TEXT
    )
  `;
  // Strictly 1:1 while active: at most one active binding per coordinator and
  // per architect. Terminal rows (detached/replaced) keep full audit history.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_architect_binding_active_coordinator
    ON coordinator_architect_binding(coordinator_thread_id)
    WHERE status = 'active'
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_architect_binding_active_architect
    ON coordinator_architect_binding(architect_thread_id)
    WHERE status = 'active'
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_architect_binding_idempotency
    ON coordinator_architect_binding(coordinator_thread_id, create_idempotency_key)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS architecture_review (
      review_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES coordinator_architect_binding(binding_id),
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
      publish_idempotency_key TEXT,
      cancel_idempotency_key TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      published_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_architecture_review_request_idempotency
    ON architecture_review(coordinator_thread_id, request_idempotency_key)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_architecture_review_coordinator_status
    ON architecture_review(coordinator_thread_id, status, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_architecture_review_binding
    ON architecture_review(binding_id, created_at)
  `;
});
