import { assert, it } from "@effect/vitest";
import * as Ft3Host from "@t3tools/ft3-host/server";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

it.effect("initializes core and ft3 schemas through the server persistence layer", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const coreBefore = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(
      coreBefore.map((row) => [row.migration_id, row.name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM ft3_migrations`, [
      { migration_id: 1, name: "Ft3Meta" },
      { migration_id: 2, name: "Board" },
      { migration_id: 3, name: "BoardReactor" },
      { migration_id: 4, name: "Architect" },
      { migration_id: 5, name: "ArchitectReviewWake" },
      { migration_id: 6, name: "Ft3DelegatedTaskSummaries" },
    ]);
    yield* sql`INSERT INTO ft3_meta VALUES ('probe', 'retained')`;

    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* Ft3Host.runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      coreBefore,
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_meta`, [
      { key: "probe", value: "retained" },
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
