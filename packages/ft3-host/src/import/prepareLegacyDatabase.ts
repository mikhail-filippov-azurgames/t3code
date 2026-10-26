import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const LIVE_DATABASE_PATH = "C:\\Users\\User\\.t3-orchestration-fork\\userdata\\state.sqlite";

export const STAGING_TABLE = "ft3_delegation_lineage_staging";
export const DELEGATION_CREATED_KIND = "delegation.created";
export const FORK_MIGRATION_MIN_ID = 53;
export const FORK_MIGRATION_NAME_PREFIX = "Legacy:";

export class LiveDatabaseRefusedError extends Schema.TaggedError<LiveDatabaseRefusedError>()(
  "LiveDatabaseRefusedError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Refusing to prepare the live fork database at '${this.path}'. Point the tool at a writable copy.`;
  }
}

export interface PreparedResult {
  readonly stagedRows: number;
  readonly migrated: ReadonlyArray<readonly [number, string]>;
}

export const isLiveDatabasePath = (filename: string): boolean => {
  const normalize = (value: string) => {
    let result = value.replaceAll("/", "\\");
    if (!/^[a-zA-Z]:[\\/]/.test(result) && !result.startsWith("\\")) {
      result = `${process.cwd().replace(/[\\/]+$/, "")}\\${result}`;
    }
    return result.replace(/[\\/]+$/, "").toLowerCase();
  };
  return normalize(filename) === normalize(LIVE_DATABASE_PATH);
};

// Negative ids keep the migrator's high-water mark below the ft3 package ids (1..5).
export const prepareLegacyDatabaseSql = Effect.fn("prepareLegacyDatabaseSql")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(STAGING_TABLE)} (
        thread_id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )`;
      yield* sql`DELETE FROM ${sql(STAGING_TABLE)}`;
      yield* sql`INSERT INTO ${sql(STAGING_TABLE)} (thread_id, created_at, payload_json)
        SELECT thread_id, created_at, payload_json
        FROM projection_thread_activities
        WHERE kind = ${DELEGATION_CREATED_KIND}`;

      const legacy = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations
        WHERE migration_id >= ${FORK_MIGRATION_MIN_ID}
        ORDER BY migration_id`;

      yield* sql`CREATE TABLE IF NOT EXISTS ft3_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      for (const row of legacy) {
        yield* sql`INSERT OR IGNORE INTO ft3_migrations (migration_id, name, created_at)
          VALUES (${-row.migration_id}, ${FORK_MIGRATION_NAME_PREFIX + row.name}, ${row.created_at})`;
      }
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${FORK_MIGRATION_MIN_ID}`;

      const [counted] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${sql(STAGING_TABLE)}`;
      return {
        stagedRows: counted?.count ?? 0,
        migrated: legacy.map((row) => [row.migration_id, row.name] as const),
      };
    }),
  );
});

export const prepareLegacyDatabase = Effect.fn("prepareLegacyDatabase")(function* (
  filename: string,
) {
  if (isLiveDatabasePath(filename)) {
    return yield* new LiveDatabaseRefusedError({ path: filename });
  }
  return yield* prepareLegacyDatabaseSql();
});
