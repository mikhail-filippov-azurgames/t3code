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

const reactor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE ft3_board_reactor_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO ft3_board_reactor_cursor VALUES (1, 0)`;
  yield* sql`
    CREATE TABLE ft3_board_reactor_wakes (
      wake_key TEXT PRIMARY KEY NOT NULL,
      orchestrator_thread_id TEXT NOT NULL REFERENCES ft3_board_orchestrators(thread_id) ON DELETE CASCADE,
      executor_thread_id TEXT NOT NULL,
      context TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE ft3_board_reactor_background (
      provider_thread_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      task_ids_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE ft3_board_reactor_outcomes (
      card_id TEXT NOT NULL REFERENCES ft3_board_cards(card_id) ON DELETE CASCADE,
      execution_key TEXT NOT NULL,
      PRIMARY KEY (card_id, execution_key)
    )
  `;
});

const retention = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_ft3_board_cards_retention ON ft3_board_cards(status, archived, updated_at)`;
});

const planning = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ft3_board_card_plans (
      card_id TEXT NOT NULL PRIMARY KEY REFERENCES ft3_board_cards(card_id) ON DELETE CASCADE,
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      required_by TEXT NOT NULL CHECK (required_by IN ('human', 'lead')),
      required_reason TEXT,
      state TEXT NOT NULL CHECK (state IN ('required', 'drafting', 'reviewing', 'discussion', 'accepted', 'withdrawn')),
      plan_doc_id TEXT NOT NULL,
      planner_member_id TEXT,
      planner_thread_id TEXT,
      review_rounds INTEGER NOT NULL DEFAULT 0 CHECK (review_rounds BETWEEN 0 AND 2),
      accepted_sha256 TEXT,
      accepted_revision INTEGER NOT NULL DEFAULT 0 CHECK (accepted_revision >= 0),
      accepted_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE ft3_board_plan_versions (
      card_id TEXT NOT NULL REFERENCES ft3_board_card_plans(card_id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('draft', 'review_1', 'review_2', 'discussion', 'accepted')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (card_id, sha256, phase)
    )
  `;
  yield* sql`CREATE INDEX idx_ft3_board_card_plans_planner_thread_id ON ft3_board_card_plans(planner_thread_id)`;
});

const planImplementStarted = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE ft3_board_card_plans ADD COLUMN implement_started_at TEXT`;
});

export const migrations = {
  "2_Board": board,
  "3_BoardReactor": reactor,
  "9_BoardRetention": retention,
  "12_BoardPlanning": planning,
  "17_BoardPlanImplementStarted": planImplementStarted,
};
