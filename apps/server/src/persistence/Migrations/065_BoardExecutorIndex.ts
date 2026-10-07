import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Index the executor lookup the board reactor performs on every terminal
 * delegated turn and every thread deletion, so it reads one row instead of
 * scanning the whole `board_cards` table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_cards_executor_thread_id
    ON board_cards(executor_thread_id)
  `;
});
