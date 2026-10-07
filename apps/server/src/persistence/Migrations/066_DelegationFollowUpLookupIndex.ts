import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cover the `delegation.follow-up-queued` probe inside
 * `listDelegatedTaskMemoryRowsQuery`, so each per-thread probe seeks a small
 * partial index instead of walking every activity row of the thread and
 * pulling its full `payload_json`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_delegation_follow_up_lookup
    ON projection_thread_activities(thread_id, sequence DESC, created_at DESC, activity_id DESC)
    WHERE kind = 'delegation.follow-up-queued'
  `;
});
