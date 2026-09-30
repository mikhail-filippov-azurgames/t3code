import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Derived summary/retry projection; delegation lineage and transcripts remain authoritative. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_delegated_task_summaries (
      child_thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS idx_delegated_task_summaries_parent
    ON projection_delegated_task_summaries(parent_environment_id, parent_thread_id, completed_at, child_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegated_task_summaries_retry
    ON projection_delegated_task_summaries(state, retry_after, updated_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegated_task_summaries_child_latest
    ON projection_delegated_task_summaries(child_thread_id, completed_at DESC, source_turn_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_activities_delegation_parent_scope
    ON projection_thread_activities(
      kind,
      json_extract(payload_json, '$.parentEnvironmentId'),
      json_extract(payload_json, '$.parentThreadId'),
      thread_id
    ) WHERE kind = 'delegation.created'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_messages_thread_turn_role_created
    ON projection_thread_messages(thread_id, turn_id, role, created_at DESC, message_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_thread_turn_sequence
    ON projection_thread_activities(thread_id, turn_id, sequence DESC, created_at DESC, activity_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_terminal_summary_recovery
    ON projection_turns(state, completed_at, thread_id, turn_id)
    WHERE turn_id IS NOT NULL AND completed_at IS NOT NULL
  `;
});
