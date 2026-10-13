import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cover the latest `delegation.created` lookup in the delegation recovery
 * sweep, so each per-thread probe seeks a small partial index instead of
 * walking every activity row of a long coordinator thread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_delegation_created_lookup
    ON projection_thread_activities(thread_id, sequence DESC, created_at DESC, activity_id DESC)
    WHERE kind = 'delegation.created'
  `;
});
