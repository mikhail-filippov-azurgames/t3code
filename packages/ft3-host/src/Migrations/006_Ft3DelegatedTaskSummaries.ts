import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ft3_delegated_task_summaries (
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
    )
  `;
  yield* sql`
    CREATE INDEX idx_ft3_delegated_task_summaries_child_latest
    ON ft3_delegated_task_summaries(child_thread_id, completed_at DESC, source_turn_id DESC)
  `;
});
