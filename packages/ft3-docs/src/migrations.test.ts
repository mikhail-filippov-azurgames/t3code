import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrations } from "./migrations.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord(migrations);

it.effect("13_Docs creates the docs tables and reruns empty", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), [[13, "Docs"]]);
    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), []);

    const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info('ft3_docs_file_state') ORDER BY cid
    `;
    assert.deepStrictEqual(
      columns.map((column) => column.name),
      [
        "stable_id",
        "rel_path",
        "sha256",
        "size",
        "mtime_ms",
        "indexed_sha256",
        "missing_passes",
        "updated_at",
      ],
    );
    assert.equal(columns.find((column) => column.name === "indexed_sha256")?.notnull, 0);

    const fts = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE name LIKE 'ft3_docs_fts%' ORDER BY name
    `;
    assert.deepStrictEqual(
      fts.map((row) => row.name),
      [
        "ft3_docs_fts",
        "ft3_docs_fts_config",
        "ft3_docs_fts_content",
        "ft3_docs_fts_data",
        "ft3_docs_fts_docsize",
        "ft3_docs_fts_idx",
      ],
    );

    const applied = yield* sql<{ readonly pk: number }>`
      SELECT COUNT(*) AS pk FROM pragma_table_info('ft3_policy_applied')
    `;
    assert.deepStrictEqual(applied, [{ pk: 8 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
