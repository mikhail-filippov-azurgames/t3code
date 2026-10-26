import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  FORK_MIGRATION_MIN_ID,
  FORK_MIGRATION_NAME_PREFIX,
  LIVE_DATABASE_PATH,
  STAGING_TABLE,
  isLiveDatabasePath,
  prepareLegacyDatabase,
  prepareLegacyDatabaseSql,
} from "./prepareLegacyDatabase.ts";

const FORK_NAMES: ReadonlyArray<string> = [
  "CalendarEvents",
  "Board",
  "DelegatedTaskSummaries",
  "DelegationRecoveryIndexes",
  "DelegatedTurnSendQueue",
  "CoordinatorArchitectBinding",
  "CoordinatorArchitectIdempotency",
  "CoordinatorArchitectRoutingEvidence",
  "ArchitectureReviewDelivery",
  "BoardCardReadiness",
  "ArchitectHumanPublication",
  "BoardRetention",
  "BoardExecutorIndex",
  "DelegationFollowUpLookupIndex",
  "BoardNudgeIndexes",
  "DelegationRecoveryCursorIndex",
  "DelegationLineageLookupIndex",
];

const createSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )`;
    yield* sql`CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sequence INTEGER
    )`;
  });

const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (let id = 1; id < FORK_MIGRATION_MIN_ID; id++) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (${id}, ${`Core${id}`}, ${`2026-01-01 00:00:${String(id % 60).padStart(2, "0")}`})`;
    }
    for (const [index, name] of FORK_NAMES.entries()) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (${FORK_MIGRATION_MIN_ID + index}, ${name}, ${`2026-09-20 12:28:${String(index % 60).padStart(2, "0")}`})`;
    }

    for (let i = 0; i < 3; i++) {
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES (${`a${i}`}, ${`thread-${i}`}, NULL, 'info', 'delegation.created', 'Delegated task created', ${`{"taskId":"t${i}"}`}, ${`2026-09-28T15:17:0${i}.000Z`}, NULL)`;
    }
    for (let i = 0; i < 2; i++) {
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES (${`t${i}`}, ${`thread-${i}`}, NULL, 'info', 'tool.completed', 'Tool completed', '{}', '2026-09-28T15:00:00.000Z', NULL)`;
    }
  });

const expectPreparedState = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const staged = yield* sql<{
      readonly thread_id: string;
      readonly created_at: string;
      readonly payload_json: string;
    }>`SELECT thread_id, created_at, payload_json FROM ${sql(STAGING_TABLE)} ORDER BY thread_id`;
    assert.deepStrictEqual(
      staged.map((row) => row.thread_id),
      ["thread-0", "thread-1", "thread-2"],
    );
    assert.deepStrictEqual(
      staged.map((row) => row.payload_json),
      ['{"taskId":"t0"}', '{"taskId":"t1"}', '{"taskId":"t2"}'],
    );

    const [maxRow] = yield* sql<{ readonly max_id: number }>`
      SELECT MAX(migration_id) AS max_id FROM effect_sql_migrations`;
    assert.strictEqual(maxRow?.max_id, FORK_MIGRATION_MIN_ID - 1);

    const journal = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM ft3_migrations ORDER BY migration_id DESC`;
    assert.strictEqual(journal.length, FORK_NAMES.length);
    assert.deepStrictEqual(
      journal.map((row) => row.migration_id),
      FORK_NAMES.map((_, index) => -(FORK_MIGRATION_MIN_ID + index)),
    );
    assert.deepStrictEqual(
      journal.map((row) => row.name),
      FORK_NAMES.map((name) => `${FORK_MIGRATION_NAME_PREFIX}${name}`),
    );
    assert.strictEqual(journal[0]?.created_at, "2026-09-20 12:28:00");
  });

describe("prepareLegacyDatabase", () => {
  it.effect("stages delegation.created rows and relocates fork migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createSchema(sql);
      yield* seed(sql);

      const result = yield* prepareLegacyDatabaseSql();

      assert.strictEqual(result.stagedRows, 3);
      assert.deepStrictEqual(
        result.migrated,
        FORK_NAMES.map((name, index) => [FORK_MIGRATION_MIN_ID + index, name] as const),
      );
      yield* expectPreparedState(sql);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is idempotent on repeated runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createSchema(sql);
      yield* seed(sql);

      yield* prepareLegacyDatabaseSql();
      const second = yield* prepareLegacyDatabaseSql();

      assert.strictEqual(second.stagedRows, 3);
      assert.strictEqual(second.migrated.length, 0);
      yield* expectPreparedState(sql);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses the live database path", () =>
    Effect.gen(function* () {
      const result = yield* prepareLegacyDatabase(LIVE_DATABASE_PATH).pipe(
        Effect.catchTags({
          LiveDatabaseRefusedError: (error) => Effect.succeed(error.path),
        }),
      );
      assert.strictEqual(result, LIVE_DATABASE_PATH);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("flags only the live database path as live", () =>
    Effect.sync(() => {
      assert.isTrue(isLiveDatabasePath(LIVE_DATABASE_PATH));
      assert.isFalse(isLiveDatabasePath("C:\\Users\\User\\AppData\\Local\\Temp\\copy.sqlite"));
      assert.isFalse(isLiveDatabasePath("C:\\tmp\\copy\\state.sqlite"));
    }),
  );
});
