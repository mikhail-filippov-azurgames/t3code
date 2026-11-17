import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { migrations as architectMigrations } from "@t3tools/ft3-architect/migrations";
import { migrations as boardMigrations } from "@t3tools/ft3-board/migrations";
import { migrations as docsMigrations } from "@t3tools/ft3-docs/migrations";
import { migrations as mailMigrations } from "@t3tools/ft3-mail/migrations";
import { migrations as policiesMigrations } from "@t3tools/ft3-policies/migrations";

import Ft3Meta from "./Migrations/001_Ft3Meta.ts";
import Ft3DelegatedTaskSummaries from "./Migrations/006_Ft3DelegatedTaskSummaries.ts";
import Ft3TaskHandoffs from "./Migrations/007_Ft3TaskHandoffs.ts";
import Ft3DelegatedTaskSummaryReactor from "./Migrations/008_Ft3DelegatedTaskSummaryReactor.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_Ft3Meta": Ft3Meta,
  ...boardMigrations,
  ...architectMigrations,
  "6_Ft3DelegatedTaskSummaries": Ft3DelegatedTaskSummaries,
  "7_Ft3TaskHandoffs": Ft3TaskHandoffs,
  "8_Ft3DelegatedTaskSummaryReactor": Ft3DelegatedTaskSummaryReactor,
  ...policiesMigrations,
  ...mailMigrations,
  ...docsMigrations,
});

export const runMigrations = Effect.fn("ft3.runMigrations")(function* () {
  return yield* run({ loader, table: "ft3_migrations" });
});

export const hasPendingMigrations = Effect.fn("ft3.hasPendingMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ft3_migrations'
  `;
  if (tables.length === 0) return true;
  const migrations = yield* loader;
  const latestMigrationId = migrations.at(-1)?.[0] ?? 0;
  const rows = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ft3_migrations
  `;
  return (rows[0]?.latestId ?? 0) < latestMigrationId;
});
