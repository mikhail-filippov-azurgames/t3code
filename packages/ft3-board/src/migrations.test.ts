import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../ft3-host/src/Migrations.ts";

describe("board migrations through ft3-host", () => {
  it.effect("creates the final legacy board columns and indexes with V2 ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations();
      const columns = yield* sql<{
        readonly name: string;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(ft3_board_cards)`;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "card_id",
          "orchestrator_thread_id",
          "title",
          "body",
          "status",
          "created_by",
          "assignee_json",
          "executor_role",
          "executor_thread_id",
          "outcome",
          "last_error",
          "failure_streak",
          "order_index",
          "archived",
          "created_at",
          "updated_at",
          "readiness",
          "readiness_note",
        ],
      );
      assert.equal(columns.find((column) => column.name === "readiness")!.dflt_value, "'ready'");
      const orchestratorFk = yield* sql<{
        readonly table: string;
        readonly on_delete: string;
      }>`PRAGMA foreign_key_list(ft3_board_orchestrators)`;
      assert.equal(orchestratorFk[0]!.table, "orchestration_v2_projection_threads");
      assert.equal(orchestratorFk[0]!.on_delete, "CASCADE");
      const cardFk = yield* sql<{
        readonly table: string;
        readonly on_delete: string;
      }>`PRAGMA foreign_key_list(ft3_board_cards)`;
      assert.equal(cardFk[0]!.table, "ft3_board_orchestrators");
      assert.equal(cardFk[0]!.on_delete, "CASCADE");
      const eventFk = yield* sql<{
        readonly table: string;
        readonly on_delete: string;
      }>`PRAGMA foreign_key_list(ft3_board_card_events)`;
      assert.equal(eventFk[0]!.table, "ft3_board_cards");
      assert.equal(eventFk[0]!.on_delete, "CASCADE");
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_list(ft3_board_card_deletions)`, []);
      const deletionColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(ft3_board_card_deletions)`;
      assert.deepStrictEqual(
        deletionColumns.map((column) => column.name),
        ["card_id", "orchestrator_thread_id", "deleted_at", "reason", "history_event_count"],
      );
      const indexes = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_ft3_board_%' ORDER BY name`;
      assert.deepStrictEqual(
        indexes.map((index) => index.name),
        [
          "idx_ft3_board_card_events_card_id",
          "idx_ft3_board_cards_executor_thread_id",
          "idx_ft3_board_cards_nudge_candidates",
          "idx_ft3_board_cards_orchestrator_thread_id",
          "idx_ft3_board_cards_retention",
          "idx_ft3_board_cards_working_ready",
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades an existing ft3 journal once and preserves cards and journal on rerun", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ft3_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, created_at DATETIME NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`;
      yield* sql`INSERT INTO ft3_migrations (migration_id, name) VALUES (1, 'Ft3Meta')`;
      yield* sql`CREATE TABLE ft3_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`;
      yield* sql`INSERT INTO ft3_meta VALUES ('retained', 'value')`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('thread:retained')`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [2, "Board"],
        [3, "BoardReactor"],
        [4, "Architect"],
        [5, "ArchitectReviewWake"],
        [6, "Ft3DelegatedTaskSummaries"],
        [7, "Ft3TaskHandoffs"],
        [8, "Ft3DelegatedTaskSummaryReactor"],
        [9, "BoardRetention"],
      ]);
      yield* sql`INSERT INTO ft3_board_orchestrators VALUES ('thread:retained', 'human', '2000-01-01')`;
      yield* sql`INSERT INTO ft3_board_cards (card_id, orchestrator_thread_id, title, body, status, created_by, executor_role, failure_streak, order_index, archived, created_at, updated_at) VALUES ('card:retained', 'thread:retained', 'Retain', 'Body', 'done', 'human', 'general', 0, 0, 1, '2000-01-01', '2000-01-02')`;
      const cardsBefore = yield* sql`SELECT * FROM ft3_board_cards`;
      const journalBefore = yield* sql`SELECT * FROM ft3_migrations`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_board_cards`, cardsBefore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_migrations`, journalBefore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_meta`, [
        { key: "retained", value: "value" },
      ]);
      assert.equal(cardsBefore[0]!.readiness, "ready");
      assert.isNull(cardsBefore[0]!.readiness_note);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "rolls back a partially applied board migration and retries after a conflict is removed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE ft3_board_cards (probe TEXT)`;
        yield* sql`INSERT INTO ft3_board_cards VALUES ('retained')`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_board_cards`, [{ probe: "retained" }]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_schema WHERE name = 'ft3_board_orchestrators'`,
          [],
        );
        assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM ft3_migrations`, []);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_schema WHERE name = 'ft3_meta'`,
          [],
        );
        yield* sql`DROP TABLE ft3_board_cards`;
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
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
