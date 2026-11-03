import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as DocsIndex from "./index.ts";
import { FT3_DOCS_FILE_STATE_DDL, FT3_DOCS_FTS_DDL, FT3_POLICY_APPLIED_DDL } from "./migrations.ts";

// The repository never carries real document ids; tests use the nil UUID.
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const OTHER_ID = "00000000-0000-0000-0000-000000000001";

const applyDocsDdl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`${sql.literal(FT3_DOCS_FILE_STATE_DDL)}`;
  yield* sql`${sql.literal(FT3_DOCS_FTS_DDL)}`;
  yield* sql`${sql.literal(FT3_POLICY_APPLIED_DDL)}`;
  return sql;
});

const withIndex = <A, E>(use: (index: DocsIndex.DocsIndex["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* applyDocsDdl;
    const index = yield* DocsIndex.DocsIndex;
    return yield* use(index);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(DocsIndex.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

describe("DocsIndex", () => {
  it.effect("constructs in this runtime: SQLite has FTS5 (design §14.6)", () =>
    withIndex((index) => Effect.succeed(assert.isNotNull(index))),
  );

  it.effect("ranks title matches above body matches", () =>
    withIndex((index) =>
      Effect.gen(function* () {
        yield* index.indexDocuments([
          {
            stableId: NIL_ID,
            relPath: "guide.md",
            title: "Reconciliation notes",
            body: "how the store works",
            sha256: "a".repeat(64),
          },
          {
            stableId: OTHER_ID,
            relPath: "other.md",
            title: "Other",
            body: "reconciliation happens on every pass",
            sha256: "b".repeat(64),
          },
        ]);

        const results = yield* index.search({ query: "reconciliation" });
        assert.deepEqual(
          results.map((result) => result.stableId),
          [NIL_ID, OTHER_ID],
        );
        const [
          top = yield* Effect.die(new Error("missing")),
          runnerUp = yield* Effect.die(new Error("missing")),
        ] = results;
        assert.isBelow(top.score, runnerUp.score);
        assert.equal(top.title, "Reconciliation notes");
      }),
    ),
  );

  it.effect("prefix queries find documents (no morphology, design §3.7)", () =>
    withIndex((index) =>
      Effect.gen(function* () {
        yield* index.indexDocuments([
          {
            stableId: NIL_ID,
            relPath: "policies/mail.md",
            title: "Mail policy",
            body: "letters wake recipients",
            sha256: "c".repeat(64),
          },
        ]);

        const exact = yield* index.search({ query: "letters" });
        assert.equal(exact.length, 1);
        const prefix = yield* index.search({ query: "letter" });
        assert.equal(prefix.length, 1);
        const morphologicalMiss = yield* index.search({ query: "письма" });
        assert.equal(morphologicalMiss.length, 0);
      }),
    ),
  );

  it.effect("scopes search to a folder and validates the limit", () =>
    withIndex((index) =>
      Effect.gen(function* () {
        yield* index.indexDocuments([
          {
            stableId: NIL_ID,
            relPath: "policies/mail.md",
            title: "Mail policy",
            body: "letters",
            sha256: "d".repeat(64),
          },
          {
            stableId: OTHER_ID,
            relPath: "notes/mail.md",
            title: "Mail notes",
            body: "letters",
            sha256: "e".repeat(64),
          },
        ]);

        const scoped = yield* index.search({ query: "letters", folder: "policies" });
        assert.deepEqual(
          scoped.map((result) => result.relPath),
          ["policies/mail.md"],
        );

        const error = yield* Effect.exit(index.search({ query: "letters", limit: 51 }));
        assert.isTrue(error._tag === "Failure");
      }),
    ),
  );

  it.effect("reindexes by sha and removes deleted documents", () =>
    withIndex((index) =>
      Effect.gen(function* () {
        const first = {
          stableId: NIL_ID,
          relPath: "doc.md",
          title: "Doc",
          body: "apple",
          sha256: "f".repeat(64),
        };
        yield* index.indexDocuments([first]);
        assert.equal((yield* index.search({ query: "apple" })).length, 1);

        // Same sha: a no-op reindex keeps serving the old body.
        yield* index.indexDocuments([first]);
        assert.equal((yield* index.search({ query: "apple" })).length, 1);

        yield* index.indexDocuments([{ ...first, body: "banana", sha256: "0".repeat(64) }]);
        assert.equal((yield* index.search({ query: "apple" })).length, 0);
        assert.equal((yield* index.search({ query: "banana" })).length, 1);

        yield* index.removeDocuments([NIL_ID]);
        assert.equal((yield* index.search({ query: "banana" })).length, 0);
      }),
    ),
  );

  it.effect("records indexed_sha256 in ft3_docs_file_state", () =>
    Effect.gen(function* () {
      const sql = yield* applyDocsDdl;
      yield* Effect.gen(function* () {
        const index = yield* DocsIndex.DocsIndex;
        yield* index.indexDocuments([
          {
            stableId: NIL_ID,
            relPath: "state.md",
            title: "State",
            body: "tracked",
            sha256: "1".repeat(64),
          },
        ]);
        const rows = yield* sql<{ readonly indexedSha256: string | null }>`
          SELECT indexed_sha256 AS "indexedSha256" FROM ft3_docs_file_state
          WHERE stable_id = ${NIL_ID}
        `;
        assert.deepEqual(rows, [{ indexedSha256: "1".repeat(64) }]);
      }).pipe(Effect.provide(DocsIndex.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
