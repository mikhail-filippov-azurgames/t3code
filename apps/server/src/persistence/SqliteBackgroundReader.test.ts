// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as SqliteBackgroundReader from "./SqliteBackgroundReader.ts";

// Removing the directory afterwards also proves both connections were closed (Windows refuses otherwise).
const withTempDatabase = <A, E>(
  use: Effect.Effect<A, E, SqlClient.SqlClient | SqliteBackgroundReader.SqliteBackgroundReader>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-background-reader-"))),
    (directory) => {
      const filename = NodePath.join(directory, "state.sqlite");
      return use.pipe(
        Effect.provide(
          Layer.merge(
            NodeSqliteClient.layer({ filename }),
            SqliteBackgroundReader.layerWorker(filename),
          ),
        ),
      );
    },
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true })),
  );

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
  yield* sql`INSERT INTO items (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')`;
});

it.effect("reads on a worker connection while the event loop keeps running", () =>
  withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* SqliteBackgroundReader.SqliteBackgroundReader;
      yield* seed;

      const rows = yield* reader.all(
        sql<{ readonly label: string }>`SELECT label FROM items WHERE id > ${1} ORDER BY id`,
      );
      assert.deepStrictEqual(rows, [{ label: "b" }, { label: "c" }]);

      // A synchronous read would finish this query before the main thread sees another turn.
      let finished = false;
      const started = yield* Deferred.make<void>();
      const slowRead = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          reader.all(sql<{ readonly n: number }>`
            WITH RECURSIVE counter(i) AS (
              SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 3000000
            )
            SELECT count(*) AS n FROM counter
          `),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            finished = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      assert.isFalse(finished);
      assert.deepStrictEqual(yield* Fiber.join(slowRead), [{ n: 3_000_000 }]);
    }),
  ),
);

it.effect("refuses writes and maps SQLite failures to SqlError", () =>
  withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* SqliteBackgroundReader.SqliteBackgroundReader;
      yield* seed;

      const write = yield* Effect.flip(
        reader.all(sql`INSERT INTO items (id, label) VALUES (9, 'z')`),
      );
      assert.equal(write._tag, "SqlError");
      assert.include(String(write.reason.cause), "readonly");

      const missing = yield* Effect.flip(reader.all(sql`SELECT nope FROM items`));
      assert.equal(missing._tag, "SqlError");
      assert.include(String(missing.reason.cause), "no such column");

      const [count] = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM items`;
      assert.equal(count?.n, 3);
      assert.deepStrictEqual(
        yield* reader.all(sql<{ readonly n: number }>`SELECT count(*) AS n FROM items`),
        [{ n: 3 }],
      );
    }),
  ),
);
