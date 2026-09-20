import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS calendar_events (
      event_id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      mode TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      next_fire_at TEXT NOT NULL,
      last_fired_at TEXT,
      last_missed_at TEXT,
      thread_id TEXT,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_calendar_events_next_fire_at
    ON calendar_events(next_fire_at)
  `;
});
