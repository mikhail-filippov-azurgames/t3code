import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Board retention storage (amendment: auto-archive of done cards, deletion
 * after retention).
 *
 * `board_card_deletions` keeps a minimal proof that a card was deleted by
 * retention: card and coordinator ids, when, why, and how many history
 * entries went with it. No title or body, so a deleted card cannot be
 * restored from it. Rows outlive the card; nothing references them.
 *
 * The data backfill restarts the retention clock for already-archived cards:
 * without it the first retention pass would delete them immediately instead
 * of after `boardDeleteArchivedAfterDays`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_card_deletions (
      card_id TEXT NOT NULL PRIMARY KEY,
      orchestrator_thread_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      history_event_count INTEGER NOT NULL
    )
  `;

  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    UPDATE board_cards
    SET updated_at = ${now}
    WHERE archived = 1
  `;
});
