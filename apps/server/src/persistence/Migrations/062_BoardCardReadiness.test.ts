import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_BoardCardReadiness", (it) => {
  it.effect("preserves existing board cards with ready defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'legacy-coordinator', 'project-1', 'Coordinator',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO board_orchestrators (thread_id, created_by, created_at)
        VALUES ('legacy-coordinator', 'human', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO board_cards (
          card_id, orchestrator_thread_id, title, body, status, created_by,
          assignee_json, executor_role, executor_thread_id, outcome, last_error,
          failure_streak, order_index, archived, created_at, updated_at
        ) VALUES (
          'legacy-card', 'legacy-coordinator', 'Keep this card', 'Existing body',
          'review', 'human', NULL, 'general', NULL, NULL, NULL, 2, 3, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 62 });

      const rows = yield* sql<{
        readonly title: string;
        readonly body: string;
        readonly status: string;
        readonly failure_streak: number;
        readonly readiness: string;
        readonly readiness_note: string | null;
      }>`
        SELECT title, body, status, failure_streak, readiness, readiness_note
        FROM board_cards
        WHERE card_id = 'legacy-card'
      `;
      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 62
      `;

      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        title: "Keep this card",
        body: "Existing body",
        status: "review",
        failure_streak: 2,
        readiness: "ready",
        readiness_note: null,
      });
      assert.equal(applied.length, 1);
    }),
  );
});
