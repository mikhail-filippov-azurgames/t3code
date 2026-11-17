import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Ft3Host from "@t3tools/ft3-host/server";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

it.effect.each(["memory", "cli"] as const)(
  "initializes core and ft3 schemas through the %s persistence layer",
  (mode) =>
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
        { migration_id: 7, name: "Ft3TaskHandoffs" },
        { migration_id: 8, name: "Ft3DelegatedTaskSummaryReactor" },
        { migration_id: 9, name: "BoardRetention" },
        { migration_id: 10, name: "PolicyUsage" },
        { migration_id: 11, name: "Mail" },
        { migration_id: 12, name: "BoardPlanning" },
        { migration_id: 13, name: "Docs" },
        { migration_id: 14, name: "MailRoute" },
        { migration_id: 15, name: "MailReactor" },
        { migration_id: 16, name: "MailDeliveryFailure" },
        { migration_id: 17, name: "BoardPlanImplementStarted" },
        { migration_id: 18, name: "MailImplementLookup" },
        { migration_id: 19, name: "BoardPlanAcceptOutbox" },
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
    }).pipe(
      Effect.provide(
        mode === "memory"
          ? SqlitePersistence.layerMemory
          : SqlitePersistence.layerCliConfig.pipe(
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "ft3-migrations-cli-" }),
              ),
              Layer.provide(NodeServices.layer),
            ),
      ),
    ),
);
