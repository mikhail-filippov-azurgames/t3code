import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ft3_delegated_task_summary_reactor_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO ft3_delegated_task_summary_reactor_cursor (id, sequence) VALUES (1, 0)
  `;
});
