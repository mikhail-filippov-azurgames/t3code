import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cover the coordinator idle-nudge sweep filters, so each pass seeks small
 * indexes instead of scanning the whole `board_cards` table:
 * `listNudgeCandidateCards` (unarchived cards in a nudge-relevant status) and
 * `hasWorkingReadyCard` (one coordinator's working-ready cards).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_cards_nudge_candidates
    ON board_cards(archived, status, orchestrator_thread_id, order_index)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_cards_working_ready
    ON board_cards(orchestrator_thread_id, archived, readiness, status)
  `;
});
