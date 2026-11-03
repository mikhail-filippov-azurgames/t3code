import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Corvis-side document state in `statev2.sqlite` (design §10.4). The
 * OpenContext file format (`folders`/`docs` in `opencontext.db`) stays
 * untouched; everything here is rebuildable derivative state.
 */

/** Reconciler bookkeeping, one row per registered document. */
export const FT3_DOCS_FILE_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_docs_file_state (
    stable_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_sha256 TEXT,
    missing_passes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )
`;

/** FTS5 index over document titles, paths and bodies (design §3.7). */
export const FT3_DOCS_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS ft3_docs_fts USING fts5(
    stable_id UNINDEXED,
    rel_path,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  )
`;

/** Applied copies of policy documents; pending external edits never land here. */
export const FT3_POLICY_APPLIED_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_policy_applied (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    file TEXT NOT NULL,
    stable_id TEXT,
    sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    applied_by TEXT NOT NULL,
    PRIMARY KEY (scope, key, file)
  )
`;

const docs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`${sql.literal(FT3_DOCS_FILE_STATE_DDL)}`;
  yield* sql`${sql.literal(FT3_DOCS_FTS_DDL)}`;
  yield* sql`${sql.literal(FT3_POLICY_APPLIED_DDL)}`;
});

export const migrations = {
  "13_Docs": docs,
};
