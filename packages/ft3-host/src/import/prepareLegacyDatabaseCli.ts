#!/usr/bin/env node

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import { prepareLegacyDatabase, STAGING_TABLE } from "./prepareLegacyDatabase.ts";

const usage = `Usage: node packages/ft3-host/src/import/prepareLegacyDatabaseCli.ts <database-copy-path>

Prepares a writable COPY of the pre-V2 fork database for the V2 migration:
  - stages delegation.created activities into ${STAGING_TABLE}
  - moves fork migration ids (>= 53) out of effect_sql_migrations into ft3_migrations
`;

const main = (): void => {
  const arg = process.argv[2];
  if (arg === undefined || arg === "--help" || arg === "-h") {
    process.stdout.write(usage);
    return;
  }
  const filename = arg;
  Effect.runPromise(
    prepareLegacyDatabase(filename).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
  ).then(
    (result) => {
      process.stdout.write(
        `Staged ${result.stagedRows} ${"delegation.created"} rows into ${STAGING_TABLE}.\n`,
      );
      process.stdout.write(
        `Registered ${result.migrated.length} legacy fork migrations in ft3_migrations.\n`,
      );
      process.stdout.write(`Prepared ${filename}.\n`);
    },
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`prepareLegacyDatabase failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
};

main();
