// @effect-diagnostics nodeBuiltinImport:off - the store owns the document files under its root.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";

import * as Frontmatter from "./frontmatter.ts";

/** Database file at the store root, beside `contexts/`. */
export const DOCS_STORE_DATABASE_FILENAME = "opencontext.db";

/** Directory under the store root that holds document files. */
export const DOCS_STORE_CONTEXTS_DIRECTORY = "contexts";

/** The store root is a folder row with this relative path and no parent. */
const ROOT_FOLDER_REL_PATH = "";

/** `SQLITE_BUSY` after `busy_timeout` is retried this many times. */
const SQLITE_BUSY_RETRIES = 3;

/**
 * The OpenContext schema, commit `0649e7134346f6f5038a9b29cc5c824ae6a54f3f`.
 * Exactly two tables and one unique index; no extra columns.
 */
const FOLDERS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    abs_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const DOCS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    abs_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    stable_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const DOCS_STABLE_ID_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_stable_id ON docs(stable_id)";

const DOCUMENT_EXTENSION = ".md";

export const DocsStoreErrorCode = Schema.Literals([
  "invalid_path",
  "invalid_name",
  "invalid_limit",
  "folder_exists",
  "folder_not_found",
  "document_exists",
  "document_not_found",
  "file_missing",
  "duplicate_stable_id",
  "store_unavailable",
]);
export type DocsStoreErrorCode = typeof DocsStoreErrorCode.Type;

export class DocsStoreError extends Schema.TaggedError<DocsStoreError>()("DocsStoreError", {
  code: DocsStoreErrorCode,
  path: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    const at = this.path === undefined ? "" : ` at "${this.path}"`;
    switch (this.code) {
      case "invalid_path":
        return `"${this.path ?? ""}" is not a path inside the document store.`;
      case "invalid_name":
        return `"${this.path ?? ""}" is not a valid document or folder name.`;
      case "invalid_limit":
        return "A manifest limit must be a whole number of at least 1.";
      case "folder_exists":
        return `Folder "${this.path ?? ""}" already exists.`;
      case "folder_not_found":
        return `Folder "${this.path ?? ""}" was not found.`;
      case "document_exists":
        return `Document "${this.path ?? ""}" already exists.`;
      case "document_not_found":
        return `Document "${this.path ?? ""}" was not found.`;
      case "file_missing":
        return `The file of document "${this.path ?? ""}" is missing.`;
      case "duplicate_stable_id":
        return `Document "${this.path ?? ""}" carries a stable id that another document already uses.`;
      case "store_unavailable":
        return `The document store${at} is unavailable.`;
    }
  }
}

export interface DocFolderRecord {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly relPath: string;
  readonly absPath: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocRecord {
  readonly id: number;
  readonly folderId: number;
  readonly name: string;
  readonly relPath: string;
  readonly absPath: string;
  readonly description: string;
  readonly stableId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One recursive manifest row. `absPath` is never part of it. */
export interface DocManifestEntry {
  readonly name: string;
  readonly relPath: string;
  readonly stableId: string;
  readonly description: string;
  readonly updatedAt: string;
}

export interface DocsStoreOptions {
  /** Store root: `contexts/` and `opencontext.db` live directly under it. */
  readonly root: string;
}

interface FolderRow {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly relPath: string;
  readonly absPath: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DocRow {
  readonly id: number;
  readonly folderId: number;
  readonly name: string;
  readonly relPath: string;
  readonly absPath: string;
  readonly description: string | null;
  readonly stableId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ManifestRow {
  readonly name: string;
  readonly relPath: string;
  readonly stableId: string | null;
  readonly description: string | null;
  readonly updatedAt: string;
}

const storeError = (code: DocsStoreErrorCode, path?: string, cause?: unknown): DocsStoreError =>
  new DocsStoreError({
    code,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Canonicalizes a store-relative path: `/` separators, no absolute roots, no
 * `.` or `..` segments, no empty segments. Returns null for anything else.
 */
function canonicalRelPath(input: string, allowEmpty: boolean): string | null {
  let candidate = input.trim().replace(/\\/g, "/");
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  if (candidate.length === 0) return allowEmpty ? "" : null;
  if (candidate.startsWith("/") || candidate.startsWith("~")) return null;
  if (/^[A-Za-z]:/.test(candidate)) return null;
  if (candidate.includes("://") || candidate.includes("\0")) return null;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function lastSegment(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? relPath : relPath.slice(index + 1);
}

function parentSegment(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}

function joinRelPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function isFolderName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name) &&
    name.trim() === name
  );
}

function isDocumentName(name: string): boolean {
  return isFolderName(name) && name.toLowerCase().endsWith(DOCUMENT_EXTENSION);
}

const folderFromRow = (row: FolderRow): DocFolderRecord => ({
  id: Number(row.id),
  parentId: row.parentId === null ? null : Number(row.parentId),
  name: row.name,
  relPath: row.relPath,
  absPath: row.absPath,
  description: row.description ?? "",
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function docFromRow(row: DocRow): DocRecord {
  if (row.stableId === null || row.stableId.length === 0) {
    throw storeError("store_unavailable", row.relPath, new Error("document row without stable_id"));
  }
  return {
    id: Number(row.id),
    folderId: Number(row.folderId),
    name: row.name,
    relPath: row.relPath,
    absPath: row.absPath,
    description: row.description ?? "",
    stableId: row.stableId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function manifestFromRow(row: ManifestRow): DocManifestEntry {
  if (row.stableId === null || row.stableId.length === 0) {
    throw storeError("store_unavailable", row.relPath, new Error("document row without stable_id"));
  }
  return {
    name: row.name,
    relPath: row.relPath,
    stableId: row.stableId,
    description: row.description ?? "",
    updatedAt: row.updatedAt,
  };
}

const isSqlError = Schema.is(SqlError);

const isBusySqlError = (error: unknown): boolean =>
  isSqlError(error) &&
  (error.cause._tag === "LockTimeoutError" ||
    /SQLITE_BUSY|database is locked/i.test(error.message));

const retryWhenBusy = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.retry(effect, { times: SQLITE_BUSY_RETRIES, while: isBusySqlError });

/** Runs one store query, retrying a busy database and reporting an unavailable store. */
const databaseQuery = <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, DocsStoreError, R> =>
  retryWhenBusy(effect).pipe(
    Effect.mapError((cause) => storeError("store_unavailable", path, cause)),
  );

const make = Effect.fn("DocsStore.make")(function* (options: DocsStoreOptions) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const contextsRoot = NodePath.resolve(options.root, DOCS_STORE_CONTEXTS_DIRECTORY);

  const folderColumns = sql`
    id, parent_id AS "parentId", name, rel_path AS "relPath", abs_path AS "absPath",
    description, created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const docColumns = sql`
    id, folder_id AS "folderId", name, rel_path AS "relPath", abs_path AS "absPath",
    description, stable_id AS "stableId", created_at AS "createdAt", updated_at AS "updatedAt"
  `;

  const timestamp = Effect.map(DateTime.now, DateTime.formatIso);

  const absoluteFor = (relPath: string): string =>
    relPath === "" ? contextsRoot : NodePath.resolve(contextsRoot, ...relPath.split("/"));

  const pathExists = Effect.fn("DocsStore.pathExists")(function* (absolutePath: string) {
    return yield* Effect.promise(() =>
      NodeFSP.access(absolutePath).then(
        () => true,
        () => false,
      ),
    );
  });

  const ensureDirectory = Effect.fn("DocsStore.ensureDirectory")(function* (directory: string) {
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(directory, { recursive: true }),
      catch: (cause) => storeError("store_unavailable", directory, cause),
    }).pipe(Effect.asVoid);
  });

  const writeDocumentFile = Effect.fn("DocsStore.writeDocumentFile")(function* (
    absolutePath: string,
    content: string,
  ) {
    yield* ensureDirectory(NodePath.dirname(absolutePath));
    const temporary = `${absolutePath}.${yield* newStableId()}.tmp`;
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.writeFile(temporary, content, "utf8");
        try {
          await NodeFSP.rename(temporary, absolutePath);
        } catch (cause) {
          await NodeFSP.rm(temporary, { force: true });
          throw cause;
        }
      },
      catch: (cause) => storeError("store_unavailable", absolutePath, cause),
    });
  });

  const readDocumentFile = Effect.fn("DocsStore.readDocumentFile")(function* (
    absolutePath: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(absolutePath, "utf8"),
      catch: (cause) => storeError("file_missing", absolutePath, cause),
    });
  });

  const newStableId = Effect.fn("DocsStore.newStableId")(function* () {
    return yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => storeError("store_unavailable", contextsRoot, cause)));
  });

  const findRootFolderRow = Effect.fn("DocsStore.findRootFolderRow")(function* () {
    const rows = yield* databaseQuery(
      ROOT_FOLDER_REL_PATH,
      sql<FolderRow>`
        SELECT ${folderColumns} FROM folders
        WHERE rel_path = ${ROOT_FOLDER_REL_PATH} AND parent_id IS NULL
        LIMIT 1
      `,
    );
    return rows[0] === undefined ? null : folderFromRow(rows[0]);
  });

  const findFolderRow = Effect.fn("DocsStore.findFolderRow")(function* (relPath: string) {
    const rows = yield* databaseQuery(
      relPath,
      sql<FolderRow>`SELECT ${folderColumns} FROM folders WHERE rel_path = ${relPath} LIMIT 1`,
    );
    return rows[0] === undefined ? null : folderFromRow(rows[0]);
  });

  const findDocRow = Effect.fn("DocsStore.findDocRow")(function* (relPath: string) {
    const rows = yield* databaseQuery(
      relPath,
      sql<DocRow>`SELECT ${docColumns} FROM docs WHERE rel_path = ${relPath} LIMIT 1`,
    );
    return rows[0] === undefined ? null : docFromRow(rows[0]);
  });

  const findDocRowByStableId = Effect.fn("DocsStore.findDocRowByStableId")(function* (
    stableId: string,
  ) {
    const rows = yield* databaseQuery(
      stableId,
      sql<DocRow>`SELECT ${docColumns} FROM docs WHERE stable_id = ${stableId} LIMIT 1`,
    );
    return rows[0] === undefined ? null : docFromRow(rows[0]);
  });

  const requireRelPath = (input: string): Effect.Effect<string, DocsStoreError> => {
    const relPath = canonicalRelPath(input, false);
    return relPath === null
      ? Effect.fail(storeError("invalid_path", input))
      : Effect.succeed(relPath);
  };

  const requireParentRelPath = (input: string): Effect.Effect<string, DocsStoreError> => {
    const relPath = canonicalRelPath(input, true);
    return relPath === null
      ? Effect.fail(storeError("invalid_path", input))
      : Effect.succeed(relPath);
  };

  const requireFolder = Effect.fn("DocsStore.requireFolder")(function* (relPath: string) {
    const folder = yield* findFolderRow(relPath);
    if (folder === null) return yield* storeError("folder_not_found", relPath);
    return folder;
  });

  const requireDocument = Effect.fn("DocsStore.requireDocument")(function* (relPath: string) {
    const document = yield* findDocRow(relPath);
    if (document === null) return yield* storeError("document_not_found", relPath);
    return document;
  });

  const ensureRootFolder = Effect.fn("DocsStore.ensureRootFolder")(function* (at: string) {
    const existing = yield* findRootFolderRow();
    if (existing !== null) return existing;
    yield* ensureDirectory(contextsRoot);
    yield* databaseQuery(
      ROOT_FOLDER_REL_PATH,
      sql`
        INSERT INTO folders (parent_id, name, rel_path, abs_path, description, created_at, updated_at)
        VALUES (NULL, '', ${ROOT_FOLDER_REL_PATH}, ${contextsRoot}, '', ${at}, ${at})
      `,
    );
    return yield* requireFolder(ROOT_FOLDER_REL_PATH);
  });

  const ensureFolderChain = Effect.fn("DocsStore.ensureFolderChain")(function* (
    relPath: string,
    at: string,
  ) {
    let folder = yield* ensureRootFolder(at);
    if (relPath === "") return folder;
    const segments = relPath.split("/");
    let current = "";
    for (const segment of segments) {
      current = joinRelPath(current, segment);
      const existing = yield* findFolderRow(current);
      if (existing !== null) {
        folder = existing;
        continue;
      }
      yield* ensureDirectory(absoluteFor(current));
      yield* databaseQuery(
        current,
        sql`
          INSERT INTO folders (parent_id, name, rel_path, abs_path, description, created_at, updated_at)
          VALUES (${folder.id}, ${segment}, ${current}, ${absoluteFor(current)}, '', ${at}, ${at})
        `,
      );
      folder = yield* requireFolder(current);
    }
    return folder;
  });

  const initialize = Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`${sql.literal(FOLDERS_SCHEMA_SQL)}`;
    yield* sql`${sql.literal(DOCS_SCHEMA_SQL)}`;
    yield* sql`${sql.literal(DOCS_STABLE_ID_INDEX_SQL)}`;
    yield* ensureRootFolder(yield* timestamp);
  });

  yield* retryWhenBusy(initialize).pipe(
    Effect.mapError((cause) => storeError("store_unavailable", contextsRoot, cause)),
  );

  const listFolders = Effect.fn("DocsStore.listFolders")(function* (parentRelPath?: string) {
    const parent = yield* requireParentRelPath(parentRelPath ?? ROOT_FOLDER_REL_PATH);
    const folder = yield* requireFolder(parent);
    const rows = yield* databaseQuery(
      parent,
      sql<FolderRow>`
        SELECT ${folderColumns} FROM folders WHERE parent_id = ${folder.id} ORDER BY name
      `,
    );
    return rows.map(folderFromRow);
  });

  const createFolder = Effect.fn("DocsStore.createFolder")(function* (input: {
    readonly relPath: string;
    readonly description?: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const name = lastSegment(relPath);
    if (!isFolderName(name)) return yield* storeError("invalid_name", relPath);
    if ((yield* findFolderRow(relPath)) !== null) {
      return yield* storeError("folder_exists", relPath);
    }
    const at = yield* timestamp;
    const parent = yield* ensureFolderChain(parentSegment(relPath), at);
    if (yield* pathExists(absoluteFor(relPath))) {
      return yield* storeError("folder_exists", relPath);
    }
    yield* ensureDirectory(absoluteFor(relPath));
    yield* retryWhenBusy(
      sql`
        INSERT INTO folders (parent_id, name, rel_path, abs_path, description, created_at, updated_at)
        VALUES (${parent.id}, ${name}, ${relPath}, ${absoluteFor(relPath)}, ${input.description ?? ""}, ${at}, ${at})
      `,
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)));
    return yield* requireFolder(relPath);
  });

  const moveFolder = Effect.fn("DocsStore.moveFolder")(function* (input: {
    readonly relPath: string;
    readonly newParentRelPath: string;
    readonly newName?: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    if (relPath === ROOT_FOLDER_REL_PATH) {
      return yield* storeError("invalid_path", relPath);
    }
    const newParent = yield* requireParentRelPath(input.newParentRelPath);
    const name = input.newName ?? lastSegment(relPath);
    if (!isFolderName(name)) return yield* storeError("invalid_name", name);
    if (newParent === relPath || newParent.startsWith(`${relPath}/`)) {
      return yield* storeError("invalid_path", newParent);
    }
    const folder = yield* requireFolder(relPath);
    const targetRelPath = joinRelPath(newParent, name);
    if (targetRelPath === relPath) return folder;
    if ((yield* findFolderRow(targetRelPath)) !== null) {
      return yield* storeError("folder_exists", targetRelPath);
    }

    const at = yield* timestamp;
    const destinationParent = yield* ensureFolderChain(newParent, at);
    const relPrefix = `${relPath}/`;
    const subtreeDocs = yield* databaseQuery(
      relPath,
      sql<DocRow>`
        SELECT ${docColumns} FROM docs
        WHERE substr(rel_path, 1, length(${relPrefix})) = ${relPrefix}
      `,
    );
    const subtreeFolderRows = yield* databaseQuery(
      relPath,
      sql<FolderRow>`
        SELECT ${folderColumns} FROM folders
        WHERE rel_path = ${relPath} OR substr(rel_path, 1, length(${relPrefix})) = ${relPrefix}
      `,
    );
    const sourcePath = absoluteFor(relPath);
    const targetPath = absoluteFor(targetRelPath);
    if (yield* pathExists(targetPath)) {
      return yield* storeError("folder_exists", targetRelPath);
    }
    yield* ensureDirectory(NodePath.dirname(targetPath));
    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(sourcePath, targetPath),
      catch: (cause) => storeError("folder_not_found", relPath, cause),
    });

    yield* retryWhenBusy(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const row of subtreeFolderRows) {
            const nextRelPath = `${targetRelPath}${row.relPath.slice(relPath.length)}`;
            yield* sql`
              UPDATE folders
              SET rel_path = ${nextRelPath}, abs_path = ${absoluteFor(nextRelPath)}, updated_at = ${at}
              WHERE id = ${row.id}
            `;
          }
          yield* sql`
            UPDATE folders
            SET parent_id = ${destinationParent.id}, name = ${name}, updated_at = ${at}
            WHERE id = ${folder.id}
          `;
          for (const row of subtreeDocs) {
            const nextRelPath = `${targetRelPath}${row.relPath.slice(relPath.length)}`;
            yield* sql`
              UPDATE docs
              SET rel_path = ${nextRelPath}, abs_path = ${absoluteFor(nextRelPath)}, updated_at = ${at}
              WHERE id = ${row.id}
            `;
          }
        }),
      ),
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", targetRelPath, cause)));

    return yield* requireFolder(targetRelPath);
  });

  const renameFolder = Effect.fn("DocsStore.renameFolder")(function* (input: {
    readonly relPath: string;
    readonly name: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    return yield* moveFolder({
      relPath,
      newParentRelPath: parentSegment(relPath),
      newName: input.name,
    });
  });

  const removeFolder = Effect.fn("DocsStore.removeFolder")(function* (input: {
    readonly relPath: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    if (relPath === ROOT_FOLDER_REL_PATH) return yield* storeError("invalid_path", relPath);
    yield* requireFolder(relPath);
    yield* retryWhenBusy(sql`DELETE FROM folders WHERE rel_path = ${relPath}`).pipe(
      Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)),
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(absoluteFor(relPath), { recursive: true, force: true }),
      catch: (cause) => storeError("store_unavailable", relPath, cause),
    }).pipe(Effect.asVoid);
  });

  const listDocs = Effect.fn("DocsStore.listDocs")(function* (folderRelPath?: string) {
    const parent = yield* requireParentRelPath(folderRelPath ?? ROOT_FOLDER_REL_PATH);
    const folder = yield* requireFolder(parent);
    const rows = yield* databaseQuery(
      parent,
      sql<DocRow>`SELECT ${docColumns} FROM docs WHERE folder_id = ${folder.id} ORDER BY name`,
    );
    return rows.map(docFromRow);
  });

  const getByPath = Effect.fn("DocsStore.getByPath")(function* (relPath: string) {
    const path = yield* requireRelPath(relPath);
    return yield* findDocRow(path);
  });

  const getByStableId = Effect.fn("DocsStore.getByStableId")(function* (stableId: string) {
    if (stableId.length === 0) return null;
    return yield* findDocRowByStableId(stableId);
  });

  const createDoc = Effect.fn("DocsStore.createDoc")(function* (input: {
    readonly relPath: string;
    readonly content?: string;
    readonly description?: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const name = lastSegment(relPath);
    if (!isDocumentName(name)) return yield* storeError("invalid_name", relPath);
    if ((yield* findDocRow(relPath)) !== null) {
      return yield* storeError("document_exists", relPath);
    }
    if (yield* pathExists(absoluteFor(relPath))) {
      return yield* storeError("document_exists", relPath);
    }

    const content = input.content ?? "";
    const frontmatterId = Frontmatter.readStableId(content);
    const stableId = frontmatterId ?? (yield* newStableId());
    if ((yield* findDocRowByStableId(stableId)) !== null) {
      return yield* storeError("duplicate_stable_id", relPath);
    }

    const at = yield* timestamp;
    const folder = yield* ensureFolderChain(parentSegment(relPath), at);
    yield* writeDocumentFile(absoluteFor(relPath), Frontmatter.writeStableId(content, stableId));
    yield* retryWhenBusy(
      sql`
        INSERT INTO docs (folder_id, name, rel_path, abs_path, description, stable_id, created_at, updated_at)
        VALUES (${folder.id}, ${name}, ${relPath}, ${absoluteFor(relPath)}, ${input.description ?? ""}, ${stableId}, ${at}, ${at})
      `,
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)));
    return yield* requireDocument(relPath);
  });

  const readDocContent = Effect.fn("DocsStore.readDocContent")(function* (input: {
    readonly relPath: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    yield* requireDocument(relPath);
    return yield* readDocumentFile(absoluteFor(relPath));
  });

  const saveDocContent = Effect.fn("DocsStore.saveDocContent")(function* (input: {
    readonly relPath: string;
    readonly content: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const document = yield* requireDocument(relPath);
    const at = yield* timestamp;
    yield* writeDocumentFile(
      absoluteFor(relPath),
      Frontmatter.writeStableId(input.content, document.stableId),
    );
    yield* retryWhenBusy(sql`UPDATE docs SET updated_at = ${at} WHERE id = ${document.id}`).pipe(
      Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)),
    );
    return yield* requireDocument(relPath);
  });

  const updateLocationByStableId = Effect.fn("DocsStore.updateLocationByStableId")(
    function* (input: { readonly stableId: string; readonly relPath: string }) {
      const relPath = yield* requireRelPath(input.relPath);
      const name = lastSegment(relPath);
      if (!isDocumentName(name)) return yield* storeError("invalid_name", relPath);
      const document = yield* findDocRowByStableId(input.stableId);
      if (document === null) return yield* storeError("document_not_found", input.stableId);
      if (document.relPath === relPath) return document;
      if ((yield* findDocRow(relPath)) !== null) {
        return yield* storeError("document_exists", relPath);
      }
      const at = yield* timestamp;
      const folder = yield* ensureFolderChain(parentSegment(relPath), at);
      yield* retryWhenBusy(
        sql`
        UPDATE docs
        SET folder_id = ${folder.id}, name = ${name}, rel_path = ${relPath},
            abs_path = ${absoluteFor(relPath)}, updated_at = ${at}
        WHERE id = ${document.id}
      `,
      ).pipe(Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)));
      return yield* requireDocument(relPath);
    },
  );

  const registerExisting = Effect.fn("DocsStore.registerExisting")(function* (input: {
    readonly relPath: string;
    readonly stableId?: string;
    readonly description?: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const name = lastSegment(relPath);
    if (!isDocumentName(name)) return yield* storeError("invalid_name", relPath);
    if ((yield* findDocRow(relPath)) !== null) {
      return yield* storeError("document_exists", relPath);
    }
    const stableId = input.stableId ?? (yield* newStableId());
    if (stableId.length === 0) return yield* storeError("invalid_path", relPath);
    if ((yield* findDocRowByStableId(stableId)) !== null) {
      return yield* storeError("duplicate_stable_id", relPath);
    }
    const at = yield* timestamp;
    const folder = yield* ensureFolderChain(parentSegment(relPath), at);
    yield* retryWhenBusy(
      sql`
        INSERT INTO docs (folder_id, name, rel_path, abs_path, description, stable_id, created_at, updated_at)
        VALUES (${folder.id}, ${name}, ${relPath}, ${absoluteFor(relPath)}, ${input.description ?? ""}, ${stableId}, ${at}, ${at})
      `,
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)));
    return yield* requireDocument(relPath);
  });

  const reassignStableId = Effect.fn("DocsStore.reassignStableId")(function* (input: {
    readonly relPath: string;
    readonly stableId: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    if (input.stableId.length === 0) return yield* storeError("invalid_path", relPath);
    const document = yield* requireDocument(relPath);
    if (document.stableId === input.stableId) return document;
    if ((yield* findDocRowByStableId(input.stableId)) !== null) {
      return yield* storeError("duplicate_stable_id", relPath);
    }
    const at = yield* timestamp;
    yield* retryWhenBusy(
      sql`UPDATE docs SET stable_id = ${input.stableId}, updated_at = ${at} WHERE id = ${document.id}`,
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)));
    return yield* requireDocument(relPath);
  });

  const ensureFolderRow = Effect.fn("DocsStore.ensureFolderRow")(function* (relPathInput: string) {
    const relPath = yield* requireRelPath(relPathInput);
    const at = yield* timestamp;
    return yield* ensureFolderChain(relPath, at);
  });

  const removeFolderRow = Effect.fn("DocsStore.removeFolderRow")(function* (relPathInput: string) {
    const relPath = yield* requireRelPath(relPathInput);
    if (relPath === ROOT_FOLDER_REL_PATH) return yield* storeError("invalid_path", relPath);
    yield* requireFolder(relPath);
    yield* retryWhenBusy(sql`DELETE FROM folders WHERE rel_path = ${relPath}`).pipe(
      Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)),
    );
  });

  const deleteDocRow = Effect.fn("DocsStore.deleteDocRow")(function* (relPathInput: string) {
    const relPath = yield* requireRelPath(relPathInput);
    yield* requireDocument(relPath);
    yield* retryWhenBusy(sql`DELETE FROM docs WHERE rel_path = ${relPath}`).pipe(
      Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)),
    );
  });

  const listAllFolders = Effect.fn("DocsStore.listAllFolders")(function* () {
    const rows = yield* databaseQuery(
      ROOT_FOLDER_REL_PATH,
      sql<FolderRow>`SELECT ${folderColumns} FROM folders ORDER BY rel_path`,
    );
    return rows.map(folderFromRow);
  });

  const setDescription = Effect.fn("DocsStore.setDescription")(function* (input: {
    readonly relPath: string;
    readonly description: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const document = yield* requireDocument(relPath);
    const at = yield* timestamp;
    yield* retryWhenBusy(
      sql`UPDATE docs SET description = ${input.description}, updated_at = ${at} WHERE id = ${document.id}`,
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)));
    return yield* requireDocument(relPath);
  });

  const moveDoc = Effect.fn("DocsStore.moveDoc")(function* (input: {
    readonly relPath: string;
    readonly newParentRelPath: string;
    readonly newName?: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const newParent = yield* requireParentRelPath(input.newParentRelPath);
    const name = input.newName ?? lastSegment(relPath);
    if (!isDocumentName(name)) return yield* storeError("invalid_name", name);
    const document = yield* requireDocument(relPath);
    const targetRelPath = joinRelPath(newParent, name);
    if (targetRelPath === relPath) return document;
    if ((yield* findDocRow(targetRelPath)) !== null) {
      return yield* storeError("document_exists", targetRelPath);
    }

    const at = yield* timestamp;
    const destinationFolder = yield* ensureFolderChain(newParent, at);
    if (yield* pathExists(absoluteFor(targetRelPath))) {
      return yield* storeError("document_exists", targetRelPath);
    }
    yield* ensureDirectory(NodePath.dirname(absoluteFor(targetRelPath)));
    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(absoluteFor(relPath), absoluteFor(targetRelPath)),
      catch: (cause) => storeError("file_missing", relPath, cause),
    });
    yield* retryWhenBusy(
      sql`
        UPDATE docs
        SET folder_id = ${destinationFolder.id}, name = ${name}, rel_path = ${targetRelPath},
            abs_path = ${absoluteFor(targetRelPath)}, updated_at = ${at}
        WHERE id = ${document.id}
      `,
    ).pipe(Effect.mapError((cause) => storeError("store_unavailable", targetRelPath, cause)));
    return yield* requireDocument(targetRelPath);
  });

  const renameDoc = Effect.fn("DocsStore.renameDoc")(function* (input: {
    readonly relPath: string;
    readonly name: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    return yield* moveDoc({
      relPath,
      newParentRelPath: parentSegment(relPath),
      newName: input.name,
    });
  });

  const removeDoc = Effect.fn("DocsStore.removeDoc")(function* (input: {
    readonly relPath: string;
  }) {
    const relPath = yield* requireRelPath(input.relPath);
    const document = yield* requireDocument(relPath);
    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(absoluteFor(relPath), { force: true }),
      catch: (cause) => storeError("store_unavailable", relPath, cause),
    }).pipe(Effect.asVoid);
    yield* retryWhenBusy(sql`DELETE FROM docs WHERE id = ${document.id}`).pipe(
      Effect.mapError((cause) => storeError("store_unavailable", relPath, cause)),
    );
  });

  const manifest = Effect.fn("DocsStore.manifest")(function* (input: {
    readonly folderRelPath?: string;
    readonly limit?: number;
  }) {
    const folder = yield* requireParentRelPath(input.folderRelPath ?? ROOT_FOLDER_REL_PATH);
    const limit = input.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return yield* storeError("invalid_limit");
    }
    if (folder !== ROOT_FOLDER_REL_PATH) yield* requireFolder(folder);
    const prefix = folder === ROOT_FOLDER_REL_PATH ? "" : `${folder}/`;
    const rows = yield* databaseQuery(
      folder,
      sql<ManifestRow>`
        SELECT name, rel_path AS "relPath", stable_id AS "stableId", description,
               updated_at AS "updatedAt"
        FROM docs
        WHERE ${prefix} = '' OR substr(rel_path, 1, length(${prefix})) = ${prefix}
        ORDER BY rel_path
        LIMIT COALESCE(${limit ?? null}, -1)
      `,
    );
    return rows.map(manifestFromRow);
  });

  return DocsStore.of({
    listFolders,
    createFolder,
    moveFolder,
    renameFolder,
    removeFolder,
    listDocs,
    getByPath,
    getByStableId,
    createDoc,
    readDocContent,
    saveDocContent,
    setDescription,
    moveDoc,
    renameDoc,
    removeDoc,
    manifest,
    updateLocationByStableId,
    registerExisting,
    reassignStableId,
    ensureFolderRow,
    removeFolderRow,
    deleteDocRow,
    listAllFolders,
  });
});

export class DocsStore extends Context.Service<
  DocsStore,
  {
    readonly listFolders: (
      parentRelPath?: string,
    ) => Effect.Effect<ReadonlyArray<DocFolderRecord>, DocsStoreError>;
    readonly createFolder: (input: {
      readonly relPath: string;
      readonly description?: string;
    }) => Effect.Effect<DocFolderRecord, DocsStoreError>;
    readonly moveFolder: (input: {
      readonly relPath: string;
      readonly newParentRelPath: string;
      readonly newName?: string;
    }) => Effect.Effect<DocFolderRecord, DocsStoreError>;
    readonly renameFolder: (input: {
      readonly relPath: string;
      readonly name: string;
    }) => Effect.Effect<DocFolderRecord, DocsStoreError>;
    readonly removeFolder: (input: {
      readonly relPath: string;
    }) => Effect.Effect<void, DocsStoreError>;
    readonly listDocs: (
      folderRelPath?: string,
    ) => Effect.Effect<ReadonlyArray<DocRecord>, DocsStoreError>;
    readonly getByPath: (relPath: string) => Effect.Effect<DocRecord | null, DocsStoreError>;
    readonly getByStableId: (stableId: string) => Effect.Effect<DocRecord | null, DocsStoreError>;
    readonly createDoc: (input: {
      readonly relPath: string;
      readonly content?: string;
      readonly description?: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    readonly readDocContent: (input: {
      readonly relPath: string;
    }) => Effect.Effect<string, DocsStoreError>;
    readonly saveDocContent: (input: {
      readonly relPath: string;
      readonly content: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    readonly setDescription: (input: {
      readonly relPath: string;
      readonly description: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    readonly moveDoc: (input: {
      readonly relPath: string;
      readonly newParentRelPath: string;
      readonly newName?: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    readonly renameDoc: (input: {
      readonly relPath: string;
      readonly name: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    readonly removeDoc: (input: {
      readonly relPath: string;
    }) => Effect.Effect<void, DocsStoreError>;
    readonly manifest: (input: {
      readonly folderRelPath?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<DocManifestEntry>, DocsStoreError>;
    /**
     * Points an existing row at a new on-disk location, matched by stable id.
     * Used by the reconciler when the human moved the file; never writes files.
     */
    readonly updateLocationByStableId: (input: {
      readonly stableId: string;
      readonly relPath: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    /**
     * Inserts a row for a file that already exists on disk (reconciler
     * registrations); generates the stable id when none is given.
     */
    readonly registerExisting: (input: {
      readonly relPath: string;
      readonly stableId?: string;
      readonly description?: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    /** Rebinds the row at `relPath` to a different stable id; the file is untouched. */
    readonly reassignStableId: (input: {
      readonly relPath: string;
      readonly stableId: string;
    }) => Effect.Effect<DocRecord, DocsStoreError>;
    /** Idempotent folder row for a directory that already exists on disk. */
    readonly ensureFolderRow: (relPath: string) => Effect.Effect<DocFolderRecord, DocsStoreError>;
    /** Deletes a folder row (cascading docs rows) without touching the disk. */
    readonly removeFolderRow: (relPath: string) => Effect.Effect<void, DocsStoreError>;
    /** Deletes a docs row without touching the disk; used after repeated missing passes. */
    readonly deleteDocRow: (relPath: string) => Effect.Effect<void, DocsStoreError>;
    readonly listAllFolders: () => Effect.Effect<ReadonlyArray<DocFolderRecord>, DocsStoreError>;
  }
>()("@t3tools/ft3-docs/store/DocsStore") {}

/**
 * A store layer owning its own `SqlClient` on `<root>/opencontext.db`: the
 * journal mode stays at SQLite's default so an external `oc` CLI can open the
 * same file, and `foreign_keys` is on so folder deletion cascades.
 */
export const layer = (options: DocsStoreOptions) =>
  Layer.effect(DocsStore, make(options)).pipe(
    Layer.provide(
      NodeSqliteClient.layer({
        filename: NodePath.join(options.root, DOCS_STORE_DATABASE_FILENAME),
        readerWorker: false,
        checkpointWorker: false,
      }),
    ),
  );
