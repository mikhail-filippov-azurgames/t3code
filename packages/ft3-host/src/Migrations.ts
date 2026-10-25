import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Ft3Meta from "./Migrations/001_Ft3Meta.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({ "1_Ft3Meta": Ft3Meta });

export const runMigrations = Effect.fn("ft3.runMigrations")(function* () {
  return yield* run({ loader, table: "ft3_migrations" });
});
