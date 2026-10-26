import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import { migrations as architectMigrations } from "@t3tools/ft3-architect/migrations";
import { migrations as boardMigrations } from "@t3tools/ft3-board/migrations";

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
});

export const runMigrations = Effect.fn("ft3.runMigrations")(function* () {
  return yield* run({ loader, table: "ft3_migrations" });
});
