import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_BoardRetention", (it) => {
  it.effect("restarts the retention clock for already-archived cards", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'retention-coordinator', 'project-1', 'Coordinator',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO board_orchestrators (thread_id, created_by, created_at)
        VALUES ('retention-coordinator', 'human', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO board_cards (
          card_id, orchestrator_thread_id, title, body, status, created_by,
          assignee_json, executor_role, executor_thread_id, outcome, last_error,
          failure_streak, order_index, archived, created_at, updated_at
        ) VALUES (
          'archived-card', 'retention-coordinator', 'Done long ago', 'Old body',
          'done', 'human', NULL, 'general', NULL, NULL, NULL, 0, 0, 1,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO board_cards (
          card_id, orchestrator_thread_id, title, body, status, created_by,
          assignee_json, executor_role, executor_thread_id, outcome, last_error,
          failure_streak, order_index, archived, created_at, updated_at
        ) VALUES (
          'active-card', 'retention-coordinator', 'Still working', 'Fresh body',
          'todo', 'human', NULL, 'general', NULL, NULL, NULL, 0, 1, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      const before = DateTime.formatIso(yield* DateTime.now);
      yield* runMigrations({ toMigrationInclusive: 64 });

      const rows = yield* sql<{
        readonly card_id: string;
        readonly archived: number;
        readonly updated_at: string;
      }>`
        SELECT card_id, archived, updated_at
        FROM board_cards
        ORDER BY card_id ASC
      `;
      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 64
      `;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_card_deletions'
      `;

      assert.equal(applied.length, 1);
      assert.equal(tables.length, 1);
      assert.equal(rows.length, 2);
      const archived = rows.find((row) => row.card_id === "archived-card");
      const active = rows.find((row) => row.card_id === "active-card");
      assert.equal(archived?.archived, 1);
      // The archived card's clock restarts at migration time, so the first
      // retention pass cannot delete it before its full retention period.
      // (`before` is captured just before the migration, so equality holds
      // even under the test clock.)
      assert.equal(archived?.updated_at, before);
      assert.notEqual(archived?.updated_at, "2026-01-01T00:00:00.000Z");
      assert.equal(active?.updated_at, "2026-01-01T00:00:00.000Z");

      // The deletion-record table carries no title or body.
      yield* sql`
        INSERT INTO board_card_deletions (
          card_id, orchestrator_thread_id, deleted_at, reason, history_event_count
        ) VALUES (
          'archived-card', 'retention-coordinator', '2026-02-01T00:00:00.000Z',
          'retention', 3
        )
      `;
      const records = yield* sql<{
        readonly card_id: string;
        readonly orchestrator_thread_id: string;
        readonly deleted_at: string;
        readonly reason: string;
        readonly history_event_count: number;
      }>`
        SELECT card_id, orchestrator_thread_id, deleted_at, reason, history_event_count
        FROM board_card_deletions
      `;
      assert.deepEqual(records, [
        {
          card_id: "archived-card",
          orchestrator_thread_id: "retention-coordinator",
          deleted_at: "2026-02-01T00:00:00.000Z",
          reason: "retention",
          history_event_count: 3,
        },
      ]);
    }),
  );
});
