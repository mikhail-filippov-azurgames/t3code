import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const architect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ft3_architect_binding (
      binding_id TEXT PRIMARY KEY,
      coordinator_thread_id TEXT NOT NULL REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE,
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
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ft3_architect_binding_active_coordinator
    ON ft3_architect_binding(coordinator_thread_id)
    WHERE status = 'active'
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ft3_architect_binding_active_architect
    ON ft3_architect_binding(architect_thread_id)
    WHERE status = 'active'
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ft3_architect_binding_idempotency
    ON ft3_architect_binding(coordinator_thread_id, create_idempotency_key)
  `;
  yield* sql`
    CREATE TABLE ft3_architect_review (
      review_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES ft3_architect_binding(binding_id) ON DELETE CASCADE,
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
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ft3_architect_review_request_idempotency
    ON ft3_architect_review(coordinator_thread_id, request_idempotency_key)
  `;
  yield* sql`
    CREATE INDEX idx_ft3_architect_review_coordinator_status
    ON ft3_architect_review(coordinator_thread_id, status, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_ft3_architect_review_binding
    ON ft3_architect_review(binding_id, created_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ft3_architect_review_unpublished_advice
    ON ft3_architect_review(binding_id)
    WHERE origin = 'architect-advice' AND status = 'answered'
  `;
});

const reviewWake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE ft3_architect_review ADD COLUMN request_wake_delivered_at TEXT`;
});

export const migrations = { "4_Architect": architect, "5_ArchitectReviewWake": reviewWake };
