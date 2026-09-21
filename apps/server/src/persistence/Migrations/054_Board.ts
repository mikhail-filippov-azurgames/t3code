import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Orchestrator kanban board storage.
 *
 * Cards and their append-only progress history cascade with the orchestrator,
 * which itself cascades with the projected thread. `foreign_keys = ON` is set
 * by the SQLite setup layer, so the FKs are the cascade mechanism.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_orchestrators (
      thread_id TEXT NOT NULL PRIMARY KEY
        REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_cards (
      card_id TEXT NOT NULL PRIMARY KEY,
      orchestrator_thread_id TEXT NOT NULL
        REFERENCES board_orchestrators(thread_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      assignee_json TEXT,
      executor_role TEXT NOT NULL,
      executor_thread_id TEXT,
      outcome TEXT,
      last_error TEXT,
      failure_streak INTEGER NOT NULL,
      order_index INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_card_events (
      entry_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL
        REFERENCES board_cards(card_id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      status TEXT NOT NULL,
      executor_role TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      body TEXT,
      source TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_cards_orchestrator_thread_id
    ON board_cards(orchestrator_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_card_events_card_id
    ON board_card_events(card_id)
  `;
});
