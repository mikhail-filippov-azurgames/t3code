import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("068_DelegationRecoveryCursorIndex", (it) => {
  it.effect("creates indexes for bounded terminal recovery scans", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_projection_turns_terminal_recovery_cursor',
          'idx_projection_turns_terminal_recovery_alias'
        )
        ORDER BY name ASC
      `;
      assert.deepEqual(
        rows.map((row) => row.name),
        [
          "idx_projection_turns_terminal_recovery_alias",
          "idx_projection_turns_terminal_recovery_cursor",
        ],
      );
    }),
  );
});
