// @effect-diagnostics nodeBuiltinImport:off - the reconciler scans the files under the store root.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";

import * as Frontmatter from "./frontmatter.ts";
import { FT3_DOCS_FILE_STATE_DDL } from "./migrations.ts";
import * as DocsStore from "./store.ts";

/** A document surfaced to subscribers of the watch service. */
export interface DocsChanged {
  readonly kind: "added" | "changed" | "moved" | "removed";
  readonly stableId: string;
  readonly relPath: string;
}

export interface DocsMove {
  readonly stableId: string;
  readonly fromRelPath: string;
  readonly toRelPath: string;
}

/** A document body the FTS index needs (re)written. */
export interface DocsIndexable {
  readonly stableId: string;
  readonly relPath: string;
  readonly title: string;
  readonly body: string;
  readonly sha256: string;
}

export interface DocsDuplicate {
  readonly keptRelPath: string;
  readonly duplicateRelPath: string;
  readonly newStableId: string;
}

export interface DocsMissing {
  readonly stableId: string;
  readonly relPath: string;
  readonly passes: number;
}

/** Result of one reconcile pass over the store (design §3.3). */
export interface ReconcileReport {
  readonly added: ReadonlyArray<DocsStore.DocRecord>;
  readonly moved: ReadonlyArray<DocsMove>;
  readonly changed: ReadonlyArray<DocsChanged>;
  readonly removed: ReadonlyArray<DocsChanged>;
  readonly missing: ReadonlyArray<DocsMissing>;
  readonly duplicates: ReadonlyArray<DocsDuplicate>;
  readonly warnings: ReadonlyArray<string>;
  /** Documents the FTS index must (re)write, with the content already read. */
  readonly toIndex: ReadonlyArray<DocsIndexable>;
  /** Stable ids the FTS index must drop (rows deleted after repeated missing passes). */
  readonly toRemove: ReadonlyArray<string>;
}

export type ReconcileError = DocsStore.DocsStoreError | SqlError;

export interface DocsReconcilerOptions {
  /** Store root: `contexts/` and `opencontext.db` live directly under it. */
  readonly root: string;
}

const MAX_FILES = 20_000;
const MAX_DEPTH = 16;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const DOCUMENT_EXTENSION = ".md";

interface ScannedFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly stableId: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly title: string;
  readonly body: string;
  readonly indexable: boolean;
}

interface FileStateRow {
  readonly stableId: string;
  readonly relPath: string;
  readonly sha256: string;
  readonly missingPasses: number;
}

type ManifestEntry = DocsStore.DocManifestEntry;

const unavailable = (path: string, cause: unknown) =>
  new DocsStore.DocsStoreError({ code: "store_unavailable", path, cause });

const sha256Hex = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Strips the frontmatter block, then takes the first `# ` heading as the title. */
function extractTitleAndBody(content: string, name: string): { title: string; body: string } {
  const range = Frontmatter.scanFrontmatter(content);
  let body = content;
  if (range !== null) {
    const closeBreak = content.indexOf("\n", range.end);
    body = closeBreak === -1 ? "" : content.slice(closeBreak + 1);
  }
  for (const line of body.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line.replace(/\r$/, ""));
    if (match !== null && match[1] !== undefined) return { title: match[1], body };
  }
  return { title: name.slice(0, -DOCUMENT_EXTENSION.length), body };
}

interface WalkState {
  readonly scans: Array<ScannedFile>;
  readonly directories: Array<string>;
  readonly warnings: Array<string>;
  fileCount: number;
  limitReached: boolean;
}

const make = Effect.fn("DocsReconciler.make")(function* (options: DocsReconcilerOptions) {
  const store = yield* DocsStore.DocsStore;
  const sql = yield* SqlClient.SqlClient;
  const contextsRoot = NodePath.resolve(options.root, DocsStore.DOCS_STORE_CONTEXTS_DIRECTORY);

  /** Shas of files the reconciler itself wrote; the matching watch event is ignored (design §3.3). */
  const selfWrites = new Map<string, string>();

  yield* sql`${sql.literal(FT3_DOCS_FILE_STATE_DDL)}`;

  const timestamp = Effect.map(DateTime.now, DateTime.formatIso);

  const scanFile = Effect.fn("DocsReconciler.scanFile")(function* (
    absPath: string,
    relPath: string,
    size: number,
    mtimeMs: number,
  ) {
    const bytes = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(absPath),
      catch: (cause) => unavailable(absPath, cause),
    });
    const content = bytes.toString("utf8");
    const { title, body } = extractTitleAndBody(content, NodePath.basename(relPath));
    return {
      relPath,
      absPath,
      stableId: Frontmatter.readStableId(content),
      sha256: sha256Hex(bytes),
      size,
      mtimeMs,
      title,
      body,
      indexable: size <= MAX_INDEX_BYTES,
    };
  });

  const walk = Effect.fn("DocsReconciler.walk")(function* (state: WalkState) {
    const visit: (
      absDir: string,
      relDir: string,
      depth: number,
    ) => Effect.Effect<void, ReconcileError> = Effect.fn("DocsReconciler.visit")(function* (
      absDir: string,
      relDir: string,
      depth: number,
    ) {
      if (state.limitReached) return;
      const entries = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(absDir, { withFileTypes: true }),
        catch: (cause) => unavailable(absDir, cause),
      });
      for (const entry of entries) {
        if (state.limitReached) return;
        const absPath = NodePath.join(absDir, entry.name);
        const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (depth + 1 > MAX_DEPTH) {
            state.warnings.push(`Directory "${relPath}" is deeper than ${MAX_DEPTH}; skipped.`);
            continue;
          }
          state.directories.push(relPath);
          yield* visit(absPath, relPath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(DOCUMENT_EXTENSION)) continue;
        if (state.fileCount + 1 > MAX_FILES) {
          state.limitReached = true;
          state.warnings.push(
            `More than ${MAX_FILES} documents; the rest is reconciled on the next pass.`,
          );
          return;
        }
        const stat = yield* Effect.tryPromise({
          try: () => NodeFSP.stat(absPath),
          catch: (cause) => unavailable(absPath, cause),
        });
        state.scans.push(yield* scanFile(absPath, relPath, stat.size, stat.mtimeMs));
        state.fileCount += 1;
      }
    });
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(contextsRoot, { recursive: true }),
      catch: (cause) => unavailable(contextsRoot, cause),
    }).pipe(Effect.asVoid);
    yield* visit(contextsRoot, "", 1);
    return state;
  });

  const writeFrontmatterId = Effect.fn("DocsReconciler.writeFrontmatterId")(function* (
    scan: ScannedFile,
    stableId: string,
  ) {
    const content = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(scan.absPath, "utf8"),
      catch: (cause) => unavailable(scan.absPath, cause),
    });
    const updated = Frontmatter.writeStableId(content, stableId);
    const temporary = `${scan.absPath}.${stableId}.tmp`;
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.writeFile(temporary, updated, "utf8");
        await NodeFSP.rename(temporary, scan.absPath);
      },
      catch: (cause) => unavailable(scan.absPath, cause),
    });
    const sha256 = sha256Hex(Buffer.from(updated, "utf8"));
    selfWrites.set(scan.absPath, sha256);
    return { stableId, sha256 };
  });

  const upsertFileState = Effect.fn("DocsReconciler.upsertFileState")(function* (input: {
    readonly stableId: string;
    readonly relPath: string;
    readonly sha256: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly missingPasses: number;
    readonly at: string;
  }) {
    yield* sql`
      INSERT INTO ft3_docs_file_state
        (stable_id, rel_path, sha256, size, mtime_ms, missing_passes, updated_at)
      VALUES
        (${input.stableId}, ${input.relPath}, ${input.sha256}, ${input.size}, ${input.mtimeMs},
         ${input.missingPasses}, ${input.at})
      ON CONFLICT(stable_id) DO UPDATE SET
        rel_path = excluded.rel_path,
        sha256 = excluded.sha256,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        missing_passes = excluded.missing_passes,
        updated_at = excluded.updated_at
    `;
  });

  const deleteFileState = (stableId: string) =>
    sql`DELETE FROM ft3_docs_file_state WHERE stable_id = ${stableId}`.pipe(Effect.asVoid);

  const reconcile = Effect.fn("DocsReconciler.reconcile")(function* () {
    const at = yield* timestamp;
    const state = yield* walk({
      scans: [],
      directories: [],
      warnings: [],
      fileCount: 0,
      limitReached: false,
    });
    const manifest = yield* store.manifest({});
    const rowsById = new Map<string, ManifestEntry>(manifest.map((row) => [row.stableId, row]));
    const rowsByPath = new Map<string, ManifestEntry>(manifest.map((row) => [row.relPath, row]));
    const stateRows = yield* sql<FileStateRow>`
      SELECT stable_id AS "stableId", rel_path AS "relPath", sha256,
             missing_passes AS "missingPasses"
      FROM ft3_docs_file_state
    `;
    const stateById = new Map(stateRows.map((row) => [row.stableId, row]));

    const added: Array<DocsStore.DocRecord> = [];
    const moved: Array<DocsMove> = [];
    const changed: Array<DocsChanged> = [];
    const removed: Array<DocsChanged> = [];
    const missing: Array<DocsMissing> = [];
    const duplicates: Array<DocsDuplicate> = [];
    const warnings: Array<string> = [...state.warnings];
    const toIndex: Array<DocsIndexable> = [];
    const toRemove: Array<string> = [];
    const matchedRelPaths = new Set<string>();

    const indexable = (scan: ScannedFile, stableId: string, sha256: string) => {
      if (!scan.indexable) {
        warnings.push(`Document "${scan.relPath}" exceeds ${MAX_INDEX_BYTES} bytes; not indexed.`);
        return;
      }
      toIndex.push({
        stableId,
        relPath: scan.relPath,
        title: scan.title,
        body: scan.body,
        sha256,
      });
    };

    // One stable id in two files: the keeper keeps it, the copies get fresh ids (design §3.3).
    const scansById = new Map<string, Array<ScannedFile>>();
    for (const scan of state.scans) {
      if (scan.stableId === null) continue;
      const group = scansById.get(scan.stableId);
      if (group === undefined) scansById.set(scan.stableId, [scan]);
      else group.push(scan);
    }
    const keeperById = new Map<string, ScannedFile>();
    for (const [stableId, group] of scansById) {
      if (group.length < 2) continue;
      const row = rowsById.get(stableId);
      const sorted = group
        .slice()
        .sort((a, b) =>
          row !== undefined
            ? Number(b.relPath === row.relPath) - Number(a.relPath === row.relPath)
            : a.mtimeMs - b.mtimeMs || (a.relPath < b.relPath ? -1 : 1),
        );
      const keeper = sorted[0];
      if (keeper === undefined) continue;
      keeperById.set(stableId, keeper);
      for (const scan of group) {
        if (scan === keeper) continue;
        if (rowsByPath.has(scan.relPath)) {
          // The copy landed on a registered path; retried after that row is freed.
          warnings.push(
            `"${scan.relPath}" already exists; the copy of "${stableId}" is reconciled later.`,
          );
          continue;
        }
        const record = yield* store.registerExisting({ relPath: scan.relPath });
        const written = yield* writeFrontmatterId(scan, record.stableId);
        added.push(record);
        changed.push({ kind: "added", stableId: record.stableId, relPath: scan.relPath });
        duplicates.push({
          keptRelPath: keeper.relPath,
          duplicateRelPath: scan.relPath,
          newStableId: record.stableId,
        });
        warnings.push(
          `Documents "${keeper.relPath}" and "${scan.relPath}" had the same id; "${scan.relPath}" received a new id.`,
        );
        rowsByPath.set(scan.relPath, {
          name: scan.relPath.slice(scan.relPath.lastIndexOf("/") + 1),
          relPath: scan.relPath,
          stableId: record.stableId,
          description: "",
          updatedAt: at,
        });
        yield* upsertFileState({
          stableId: record.stableId,
          relPath: scan.relPath,
          sha256: written.sha256,
          size: scan.size,
          mtimeMs: scan.mtimeMs,
          missingPasses: 0,
          at,
        });
        indexable(scan, record.stableId, written.sha256);
      }
    }

    for (const scan of state.scans) {
      if (scan.stableId !== null) {
        const keeper = keeperById.get(scan.stableId);
        if (keeper !== undefined && keeper !== scan) continue; // duplicate copy, handled above
      }
      const frontmatterId = scan.stableId;
      const rowById = frontmatterId === null ? undefined : rowsById.get(frontmatterId);
      const rowByPath = rowsByPath.get(scan.relPath);

      if (rowById !== undefined) {
        matchedRelPaths.add(rowById.relPath);
        if (rowById.relPath === scan.relPath) {
          const previous = stateById.get(rowById.stableId);
          yield* upsertFileState({
            stableId: rowById.stableId,
            relPath: scan.relPath,
            sha256: scan.sha256,
            size: scan.size,
            mtimeMs: scan.mtimeMs,
            missingPasses: 0,
            at,
          });
          if (previous === undefined || previous.sha256 !== scan.sha256) {
            changed.push({ kind: "changed", stableId: rowById.stableId, relPath: scan.relPath });
            indexable(scan, rowById.stableId, scan.sha256);
          }
        } else if (rowByPath !== undefined && rowByPath.stableId !== rowById.stableId) {
          // Another document's row sits at this path; the move happens once it is freed.
          warnings.push(
            `"${scan.relPath}" is occupied by "${rowByPath.stableId}"; the move of "${rowById.relPath}" waits for it.`,
          );
        } else {
          const record = yield* store.updateLocationByStableId({
            stableId: rowById.stableId,
            relPath: scan.relPath,
          });
          moved.push({
            stableId: record.stableId,
            fromRelPath: rowById.relPath,
            toRelPath: scan.relPath,
          });
          changed.push({ kind: "moved", stableId: record.stableId, relPath: scan.relPath });
          rowsByPath.delete(rowById.relPath);
          rowsByPath.set(scan.relPath, {
            name: scan.relPath.slice(scan.relPath.lastIndexOf("/") + 1),
            relPath: scan.relPath,
            stableId: record.stableId,
            description: record.description,
            updatedAt: record.updatedAt,
          });
          yield* upsertFileState({
            stableId: record.stableId,
            relPath: scan.relPath,
            sha256: scan.sha256,
            size: scan.size,
            mtimeMs: scan.mtimeMs,
            missingPasses: 0,
            at,
          });
          indexable(scan, record.stableId, scan.sha256);
        }
        continue;
      }

      if (rowByPath !== undefined) {
        matchedRelPaths.add(rowByPath.relPath);
        if (frontmatterId === null) {
          // No frontmatter id (external `oc` write or a pre-migration store): adopt the row id.
          const written = yield* writeFrontmatterId(scan, rowByPath.stableId);
          changed.push({ kind: "changed", stableId: rowByPath.stableId, relPath: scan.relPath });
          yield* upsertFileState({
            stableId: rowByPath.stableId,
            relPath: scan.relPath,
            sha256: written.sha256,
            size: scan.size,
            mtimeMs: scan.mtimeMs,
            missingPasses: 0,
            at,
          });
          indexable(scan, rowByPath.stableId, written.sha256);
        } else {
          // The file brings an unknown id to a registered path; the file wins.
          const record = yield* store.reassignStableId({
            relPath: scan.relPath,
            stableId: frontmatterId,
          });
          changed.push({ kind: "changed", stableId: record.stableId, relPath: scan.relPath });
          toRemove.push(rowByPath.stableId);
          yield* deleteFileState(rowByPath.stableId);
          yield* upsertFileState({
            stableId: record.stableId,
            relPath: scan.relPath,
            sha256: scan.sha256,
            size: scan.size,
            mtimeMs: scan.mtimeMs,
            missingPasses: 0,
            at,
          });
          indexable(scan, record.stableId, scan.sha256);
        }
        continue;
      }

      // Brand-new file on disk.
      const record =
        frontmatterId === null
          ? yield* store.registerExisting({ relPath: scan.relPath })
          : yield* store.registerExisting({ relPath: scan.relPath, stableId: frontmatterId });
      const written =
        frontmatterId === null
          ? yield* writeFrontmatterId(scan, record.stableId)
          : { stableId: record.stableId, sha256: scan.sha256 };
      added.push(record);
      changed.push({ kind: "added", stableId: record.stableId, relPath: scan.relPath });
      yield* upsertFileState({
        stableId: record.stableId,
        relPath: scan.relPath,
        sha256: written.sha256,
        size: scan.size,
        mtimeMs: scan.mtimeMs,
        missingPasses: 0,
        at,
      });
      indexable(scan, record.stableId, written.sha256);
    }

    // Rows whose file is gone: aged out after the second consecutive pass without it.
    for (const row of manifest) {
      if (matchedRelPaths.has(row.relPath)) continue;
      const previous = stateById.get(row.stableId);
      const passes = (previous?.missingPasses ?? 0) + 1;
      if (passes >= 2) {
        yield* store.deleteDocRow(row.relPath);
        yield* deleteFileState(row.stableId);
        removed.push({ kind: "removed", stableId: row.stableId, relPath: row.relPath });
        toRemove.push(row.stableId);
      } else {
        yield* upsertFileState({
          stableId: row.stableId,
          relPath: row.relPath,
          sha256: "",
          size: 0,
          mtimeMs: 0,
          missingPasses: passes,
          at,
        });
        missing.push({ stableId: row.stableId, relPath: row.relPath, passes });
      }
    }

    // Folder rows follow the directories on disk; rows of vanished directories go (design §3.3).
    const onDisk = new Set(state.directories);
    const folderRows = yield* store.listAllFolders();
    for (const folder of folderRows) {
      if (folder.relPath === "" || onDisk.has(folder.relPath)) continue;
      const prefix = `${folder.relPath}/`;
      for (const row of manifest) {
        if (row.relPath.startsWith(prefix)) yield* deleteFileState(row.stableId);
      }
      yield* store.removeFolderRow(folder.relPath);
    }
    for (const directory of state.directories) {
      yield* store.ensureFolderRow(directory);
    }

    return {
      added,
      moved,
      changed,
      removed,
      missing,
      duplicates,
      warnings,
      toIndex,
      toRemove,
    };
  });

  /** True once per recorded self-write: the matching watch event is consumed. */
  const isSelfWrite = (absPath: string): boolean => selfWrites.delete(NodePath.resolve(absPath));

  return DocsReconciler.of({ reconcile, isSelfWrite });
});

export class DocsReconciler extends Context.Service<
  DocsReconciler,
  {
    /** One full pass over the store; idempotent for an unchanged tree. */
    readonly reconcile: () => Effect.Effect<ReconcileReport, ReconcileError>;
    /** Consumes the self-write record for `absPath`; true when it was recorded. */
    readonly isSelfWrite: (absPath: string) => boolean;
  }
>()("@t3tools/ft3-docs/reconciler/DocsReconciler") {}

/**
 * The reconciler owns the `ft3_docs_file_state` table in the ambient
 * `statev2.sqlite` `SqlClient`; the document format itself stays in the store's
 * own client on `opencontext.db`. Requires `DocsStore` and `SqlClient`.
 */
export const layer = (options: DocsReconcilerOptions) =>
  Layer.effect(DocsReconciler, make(options));
