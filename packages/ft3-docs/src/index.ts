import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { DocsIndexable } from "./reconciler.ts";
import { FT3_DOCS_FTS_DDL } from "./migrations.ts";

export const DocsIndexErrorCode = Schema.Literals([
  "fts5_unavailable",
  "invalid_limit",
  "index_unavailable",
]);
export type DocsIndexErrorCode = typeof DocsIndexErrorCode.Type;

export class DocsIndexError extends Schema.TaggedError<DocsIndexError>()("DocsIndexError", {
  code: DocsIndexErrorCode,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "fts5_unavailable":
        return "FTS5 is not available in this SQLite runtime; the document index and docs_search are unavailable.";
      case "invalid_limit":
        return "A search limit must be a whole number between 1 and 50.";
      case "index_unavailable":
        return "The document index is unavailable.";
    }
  }
}

const FTS_PROBE_DDL = "CREATE VIRTUAL TABLE temp.ft3_docs_fts_probe USING fts5(x)";
const FTS_TABLE = "ft3_docs_fts";
const HIGH_CODE_POINT = "\u{10FFFF}";

const indexError = (code: DocsIndexErrorCode, cause?: unknown) =>
  new DocsIndexError({
    code,
    ...(cause === undefined ? {} : { cause }),
  });

export interface DocsSearchResult {
  readonly stableId: string;
  readonly relPath: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}

export interface DocsSearchInput {
  readonly query: string;
  readonly folder?: string;
  readonly limit?: number;
}

const MAX_LIMIT = 50;

/** Builds the FTS5 match expression: every word becomes a prefix term (design §3.7). */
const buildMatchQuery = (query: string): string | null => {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"*`);
  return terms.length === 0 ? null : terms.join(" ");
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Functional probe: compile options can lie, a temp virtual table cannot.
  const probe = yield* Effect.exit(sql`${sql.literal(FTS_PROBE_DDL)}`);
  if (probe._tag === "Failure") {
    return yield* indexError("fts5_unavailable", probe.cause);
  }
  yield* sql`DROP TABLE IF EXISTS temp.ft3_docs_fts_probe`.pipe(Effect.ignoreCause);

  yield* sql`${sql.literal(FT3_DOCS_FTS_DDL)}`;

  const timestamp = Effect.map(DateTime.now, DateTime.formatIso);

  const indexOne = Effect.fn("DocsIndex.indexOne")(function* (entry: DocsIndexable) {
    const indexed = yield* sql<{ readonly indexedSha256: string | null }>`
      SELECT indexed_sha256 AS "indexedSha256" FROM ft3_docs_file_state
      WHERE stable_id = ${entry.stableId}
    `;
    if (indexed[0]?.indexedSha256 === entry.sha256) return;
    const at = yield* timestamp;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM ft3_docs_fts WHERE stable_id = ${entry.stableId}`;
        yield* sql`
          INSERT INTO ft3_docs_fts (stable_id, rel_path, title, body)
          VALUES (${entry.stableId}, ${entry.relPath}, ${entry.title}, ${entry.body})
        `;
        yield* sql`
          INSERT INTO ft3_docs_file_state
            (stable_id, rel_path, sha256, size, mtime_ms, missing_passes, indexed_sha256, updated_at)
          VALUES
            (${entry.stableId}, ${entry.relPath}, ${entry.sha256}, 0, 0, 0, ${entry.sha256}, ${at})
          ON CONFLICT(stable_id) DO UPDATE SET
            rel_path = excluded.rel_path,
            indexed_sha256 = excluded.indexed_sha256,
            updated_at = excluded.updated_at
        `;
      }),
    );
  });

  const indexDocuments = Effect.fn("DocsIndex.indexDocuments")(function* (
    entries: ReadonlyArray<DocsIndexable>,
  ) {
    for (const entry of entries) {
      yield* Effect.mapError(indexOne(entry), (cause) => indexError("index_unavailable", cause));
    }
  });

  const removeDocuments = Effect.fn("DocsIndex.removeDocuments")(function* (
    stableIds: ReadonlyArray<string>,
  ) {
    for (const stableId of stableIds) {
      yield* sql`DELETE FROM ft3_docs_fts WHERE stable_id = ${stableId}`.pipe(
        Effect.mapError((cause) => indexError("index_unavailable", cause)),
      );
    }
  });

  const search = Effect.fn("DocsIndex.search")(function* (input: DocsSearchInput) {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return yield* indexError("invalid_limit");
    }
    const match = buildMatchQuery(input.query);
    if (match === null) return [];
    const folder = input.folder?.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = folder === undefined || folder.length === 0 ? null : `${folder}/`;
    const upper = prefix === null ? null : prefix + HIGH_CODE_POINT;
    const rows = yield* sql<{
      readonly stableId: string;
      readonly relPath: string;
      readonly title: string;
      readonly snippet: string;
      readonly score: number;
    }>`
      SELECT stable_id AS "stableId", rel_path AS "relPath", title,
             snippet(${sql.literal(FTS_TABLE)}, 3, '<mark>', '</mark>', '…', 32) AS snippet,
             bm25(${sql.literal(FTS_TABLE)}, 0.0, 2.0, 4.0, 1.0) AS score
      FROM ${sql.literal(FTS_TABLE)}
      WHERE ${sql.literal(FTS_TABLE)} MATCH ${match}
        AND (${prefix} IS NULL OR rel_path >= ${prefix})
        AND (${upper} IS NULL OR rel_path < ${upper})
      ORDER BY score
      LIMIT ${limit}
    `.pipe(Effect.mapError((cause) => indexError("index_unavailable", cause)));
    return rows;
  });

  return DocsIndex.of({ indexDocuments, removeDocuments, search });
});

export class DocsIndex extends Context.Service<
  DocsIndex,
  {
    /** (Re)indexes changed documents; entries whose sha is already indexed are skipped. */
    readonly indexDocuments: (
      entries: ReadonlyArray<DocsIndexable>,
    ) => Effect.Effect<void, DocsIndexError, never>;
    readonly removeDocuments: (
      stableIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, DocsIndexError, never>;
    readonly search: (
      input: DocsSearchInput,
    ) => Effect.Effect<ReadonlyArray<DocsSearchResult>, DocsIndexError, never>;
  }
>()("@t3tools/ft3-docs/DocsIndex") {}

/**
 * `DocsIndex` uses the ambient `statev2.sqlite` `SqlClient` (design §10.4).
 * Construction fails with `fts5_unavailable` when the runtime SQLite lacks
 * FTS5; callers degrade by leaving search off while reconcile keeps working.
 */
export const layer = Layer.effect(DocsIndex, make);

/**
 * The index when the runtime lacks FTS5: reconcile and writes keep working,
 * `docs_search` reports the reason instead of failing the whole service.
 */
export const unavailableLayer: Layer.Layer<DocsIndex> = Layer.succeed(
  DocsIndex,
  DocsIndex.of({
    indexDocuments: Effect.fn("DocsIndex.unavailable.indexDocuments")(() => Effect.void),
    removeDocuments: Effect.fn("DocsIndex.unavailable.removeDocuments")(() => Effect.void),
    search: Effect.fn("DocsIndex.unavailable.search")(() =>
      Effect.fail(indexError("fts5_unavailable")),
    ),
  }),
);

/** Applies one reconcile report to the index; the wiring the composition uses. */
export const applyReport = (
  index: DocsIndex["Service"],
  report: {
    readonly toIndex: ReadonlyArray<DocsIndexable>;
    readonly toRemove: ReadonlyArray<string>;
  },
) =>
  Effect.andThen(index.removeDocuments(report.toRemove), () =>
    index.indexDocuments(report.toIndex),
  );
