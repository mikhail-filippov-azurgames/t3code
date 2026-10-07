import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE board_cards
    ADD COLUMN readiness TEXT NOT NULL DEFAULT 'ready'
  `;
  yield* sql`
    ALTER TABLE board_cards
    ADD COLUMN readiness_note TEXT
  `;
});
