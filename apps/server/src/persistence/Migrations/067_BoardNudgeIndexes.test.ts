import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("067_BoardNudgeIndexes", (it) => {
  it.effect("creates indexes for the board nudge sweep filters", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_board_cards_nudge_candidates',
          'idx_board_cards_working_ready'
        )
        ORDER BY name ASC
      `;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["idx_board_cards_nudge_candidates", "idx_board_cards_working_ready"],
      );

      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 67
      `;
      assert.equal(applied.length, 1);
    }),
  );
});
