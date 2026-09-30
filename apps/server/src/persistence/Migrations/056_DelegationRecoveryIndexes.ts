import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_delegation_completed_lookup
    ON projection_thread_activities(
      thread_id,
      json_extract(payload_json, '$.childThreadId'),
      json_extract(payload_json, '$.delegatedTurnId'),
      sequence DESC,
      created_at DESC,
      activity_id DESC
    ) WHERE kind = 'delegation.completed'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_delegation_wake_delivered
    ON projection_thread_activities(thread_id)
    WHERE kind = 'delegation.wake-delivered'
  `;
});
