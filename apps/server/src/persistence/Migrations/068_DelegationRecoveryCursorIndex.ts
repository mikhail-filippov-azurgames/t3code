import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_terminal_recovery_cursor
    ON projection_turns(completed_at DESC, thread_id DESC, turn_id DESC)
    WHERE turn_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND state IN ('completed', 'interrupted', 'error')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_terminal_recovery_alias
    ON projection_turns(turn_id, thread_id)
    WHERE turn_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND state IN ('completed', 'interrupted', 'error')
  `;
});
