import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ft3_task_handoffs (
      task_id TEXT PRIMARY KEY NOT NULL,
      parent_thread_id TEXT NOT NULL,
      handoff_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
