import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const board = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ft3_board_orchestrators (
      thread_id TEXT NOT NULL PRIMARY KEY REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE ft3_board_cards (
      card_id TEXT NOT NULL PRIMARY KEY,
      orchestrator_thread_id TEXT NOT NULL REFERENCES ft3_board_orchestrators(thread_id) ON DELETE CASCADE,
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
      updated_at TEXT NOT NULL,
      readiness TEXT NOT NULL DEFAULT 'ready',
      readiness_note TEXT
    )
  `;
  yield* sql`
    CREATE TABLE ft3_board_card_events (
      entry_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES ft3_board_cards(card_id) ON DELETE CASCADE,
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
    CREATE TABLE ft3_board_card_deletions (
      card_id TEXT NOT NULL PRIMARY KEY,
      orchestrator_thread_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      history_event_count INTEGER NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_ft3_board_cards_orchestrator_thread_id ON ft3_board_cards(orchestrator_thread_id)`;
  yield* sql`CREATE INDEX idx_ft3_board_card_events_card_id ON ft3_board_card_events(card_id)`;
  yield* sql`CREATE INDEX idx_ft3_board_cards_executor_thread_id ON ft3_board_cards(executor_thread_id)`;
  yield* sql`CREATE INDEX idx_ft3_board_cards_nudge_candidates ON ft3_board_cards(archived, status, orchestrator_thread_id, order_index)`;
  yield* sql`CREATE INDEX idx_ft3_board_cards_working_ready ON ft3_board_cards(orchestrator_thread_id, archived, readiness, status)`;
});

export const migrations = { "2_Board": board };
