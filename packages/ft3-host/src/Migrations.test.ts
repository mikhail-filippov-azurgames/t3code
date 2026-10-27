import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./server.ts";

describe("ft3 migrations", () => {
  it.effect("uses its own journal without creating the core journal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      assert.deepStrictEqual(yield* runMigrations(), [
        [1, "Ft3Meta"],
        [2, "Board"],
        [3, "BoardReactor"],
        [4, "Architect"],
        [5, "ArchitectReviewWake"],
        [6, "Ft3DelegatedTaskSummaries"],
        [7, "Ft3TaskHandoffs"],
        [8, "Ft3DelegatedTaskSummaryReactor"],
        [9, "BoardRetention"],
      ]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "ft3_architect_binding",
          "ft3_architect_review",
          "ft3_board_card_deletions",
          "ft3_board_card_events",
          "ft3_board_cards",
          "ft3_board_orchestrators",
          "ft3_board_reactor_background",
          "ft3_board_reactor_cursor",
          "ft3_board_reactor_outcomes",
          "ft3_board_reactor_wakes",
          "ft3_delegated_task_summaries",
          "ft3_delegated_task_summary_reactor_cursor",
          "ft3_meta",
          "ft3_migrations",
          "ft3_task_handoffs",
        ],
      );
      const journal = yield* sql`SELECT migration_id, name FROM ft3_migrations`;
      assert.deepStrictEqual(journal, [
        { migration_id: 1, name: "Ft3Meta" },
        { migration_id: 2, name: "Board" },
        { migration_id: 3, name: "BoardReactor" },
        { migration_id: 4, name: "Architect" },
        { migration_id: 5, name: "ArchitectReviewWake" },
        { migration_id: 6, name: "Ft3DelegatedTaskSummaries" },
        { migration_id: 7, name: "Ft3TaskHandoffs" },
        { migration_id: 8, name: "Ft3DelegatedTaskSummaryReactor" },
        { migration_id: 9, name: "BoardRetention" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("preserves the core journal and existing metadata on repeated runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations VALUES (1000, 'CoreSentinel', '2026-01-01 00:00:00')
      `;
      const coreBefore = yield* sql`SELECT * FROM effect_sql_migrations`;

      assert.deepStrictEqual(yield* runMigrations(), [
        [1, "Ft3Meta"],
        [2, "Board"],
        [3, "BoardReactor"],
        [4, "Architect"],
        [5, "ArchitectReviewWake"],
        [6, "Ft3DelegatedTaskSummaries"],
        [7, "Ft3TaskHandoffs"],
        [8, "Ft3DelegatedTaskSummaryReactor"],
        [9, "BoardRetention"],
      ]);
      yield* sql`INSERT INTO ft3_meta VALUES ('probe', 'retained')`;
      const ft3Before = yield* sql`SELECT * FROM ft3_migrations`;

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM effect_sql_migrations`, coreBefore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_migrations`, ft3Before);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_meta`, [
        { key: "probe", value: "retained" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not record a failed migration and can run after the conflict is removed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ft3_meta (probe TEXT)`;
      yield* sql`INSERT INTO ft3_meta VALUES ('retained')`;

      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_migrations`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_meta`, [{ probe: "retained" }]);

      yield* sql`DROP TABLE ft3_meta`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [1, "Ft3Meta"],
        [2, "Board"],
        [3, "BoardReactor"],
        [4, "Architect"],
        [5, "ArchitectReviewWake"],
        [6, "Ft3DelegatedTaskSummaries"],
        [7, "Ft3TaskHandoffs"],
        [8, "Ft3DelegatedTaskSummaryReactor"],
        [9, "BoardRetention"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
