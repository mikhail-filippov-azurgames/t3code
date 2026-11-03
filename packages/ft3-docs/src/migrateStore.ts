// @effect-diagnostics nodeBuiltinImport:off - the one-shot migrator scans, backs up and rewrites the store files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Frontmatter from "./frontmatter.ts";
import { DocsReconciler } from "./reconciler.ts";
import { DOCS_STORE_CONTEXTS_DIRECTORY, DOCS_STORE_DATABASE_FILENAME } from "./store.ts";

/** One-shot migration of an existing OpenContext store (design В§3.8). Never deletes a file: it
 * registers unknown documents, backfills `stable_id`, rewrites `abs_path`, and refuses to write
 * when a file changed after the dry run the report came from. */

export const MIGRATE_STORE_REPORT_KIND = "ft3-docs/store-migration-report-v1";

const DOCUMENT_EXTENSION = ".md";
const MAX_FILES = 20_000;
const MAX_DEPTH = 16;
const DOC_LINK_SOURCE =
  "\\boc(?:l)?://doc/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:@\\d+)?";

export const MigrateStoreErrorCode = Schema.Literals([
  "store_missing",
  "database_unavailable",
  "file_scan_failed",
  "report_root_mismatch",
  "store_changed_since_dry_run",
  "backup_failed",
  "migration_failed",
]);
export type MigrateStoreErrorCode = typeof MigrateStoreErrorCode.Type;

export class MigrateStoreError extends Schema.TaggedError<MigrateStoreError>()(
  "MigrateStoreError",
  {
    code: MigrateStoreErrorCode,
    path: Schema.optionalKey(Schema.String),
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : this.detail;
    switch (this.code) {
      case "store_missing":
        return `The document store at "${this.path ?? ""}" is unavailable${detail}.`;
      case "database_unavailable":
        return `The document store database "${this.path ?? ""}" is missing or unreadable${detail}.`;
      case "file_scan_failed":
        return `Cannot read the store files under "${this.path ?? ""}"${detail}.`;
      case "report_root_mismatch":
        return `The dry-run report does not belong to "${this.path ?? ""}"${detail}; nothing was written.`;
      case "store_changed_since_dry_run":
        return `The store changed after the dry run${detail}; nothing was written. Run the dry run again.`;
      case "backup_failed":
        return `The backup at "${this.path ?? ""}" failed${detail}; nothing was written.`;
      case "migration_failed":
        return `The migration of "${this.path ?? ""}" failed${detail}; restore the store from the backup.`;
    }
  }
}

const isMigrateStoreError = Schema.is(MigrateStoreError);

export interface MigrateStoreFileFingerprint {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface MigrateStoreAbsPathRewrite {
  readonly table: "docs" | "folders";
  readonly relPath: string;
  readonly from: string;
  readonly to: string;
}

export interface MigrateStoreDuplicate {
  readonly stableId: string;
  readonly relPaths: ReadonlyArray<string>;
}

export interface MigrateStoreOrphanRow {
  readonly stableId: string;
  readonly relPath: string;
}

/** Everything the human reviews before the real run; JSON-serializable on purpose. */
export interface MigrateStoreReport {
  readonly kind: typeof MIGRATE_STORE_REPORT_KIND;
  readonly root: string;
  readonly contextsRoot: string;
  readonly generatedAt: string;
  readonly fileCount: number;
  readonly documentRowCount: number;
  readonly folderRowCount: number;
  /** Files on disk without a `docs` row. */
  readonly unregisteredFiles: ReadonlyArray<string>;
  /** Files whose frontmatter has no `stable_id` field. */
  readonly filesWithoutStableId: ReadonlyArray<string>;
  /** Files with no frontmatter block at all; these receive a new block. */
  readonly filesNeedingFrontmatterBlock: ReadonlyArray<string>;
  readonly dbRowsWithoutFiles: ReadonlyArray<MigrateStoreOrphanRow>;
  readonly absPathRewrites: ReadonlyArray<MigrateStoreAbsPathRewrite>;
  readonly duplicates: ReadonlyArray<MigrateStoreDuplicate>;
  /** `oc://doc/<id>` links in the store text that no document resolves today. */
  readonly danglingLinks: ReadonlyArray<string>;
  readonly files: ReadonlyArray<MigrateStoreFileFingerprint>;
  readonly warnings: ReadonlyArray<string>;
}

export type MigrateStoreIssueCode =
  | "unregistered_file"
  | "duplicate_stable_id"
  | "frontmatter_id_mismatch"
  | "abs_path_mismatch"
  | "abs_path_outside_root"
  | "file_bytes_changed"
  | "backup_file_missing"
  | "dangling_link_added"
  | "row_without_file"
  | "dangling_link_preexisting";

export interface MigrateStoreIssue {
  readonly code: MigrateStoreIssueCode;
  readonly detail: string;
}

export interface MigrateStoreVerification {
  /** False when any blocking issue was found; the human restores the backup. */
  readonly ok: boolean;
  readonly checkedFiles: number;
  readonly checkedRows: number;
  readonly issues: ReadonlyArray<MigrateStoreIssue>;
  readonly warnings: ReadonlyArray<MigrateStoreIssue>;
}

export interface MigrateStoreDocumentRegistration {
  readonly relPath: string;
  readonly stableId: string;
}

export interface MigrateStoreFrontmatterWrite {
  readonly relPath: string;
  readonly stableId: string;
  readonly addedBlock: boolean;
}

export interface MigrateStoreBackup {
  readonly directory: string;
  readonly databasePath: string;
  readonly files: number;
}

export interface MigrateStoreResult {
  readonly status: "up_to_date" | "migrated";
  /** Fresh inspection of the store the run executed against. */
  readonly plan: MigrateStoreReport;
  readonly backupDirectory: string | null;
  readonly backupDatabasePath: string | null;
  readonly backedUpFiles: number;
  readonly registeredDocuments: ReadonlyArray<MigrateStoreDocumentRegistration>;
  readonly frontmatterWrites: ReadonlyArray<MigrateStoreFrontmatterWrite>;
  readonly absPathRewrites: ReadonlyArray<MigrateStoreAbsPathRewrite>;
  readonly verification: MigrateStoreVerification;
  readonly warnings: ReadonlyArray<string>;
}

export interface MigrateStoreOptions {
  /** Store root: `contexts/` and `opencontext.db` live directly under it. */
  readonly root: string;
  /**
   * Report of a dry run over the same, unchanged store. The real run refuses to
   * write when any file's size or mtime moved after that report.
   */
  readonly report: MigrateStoreReport;
}

interface MigrateStoreDocumentRow {
  readonly stableId: string;
  readonly relPath: string;
  readonly absPath: string;
}

interface MigrateStoreFolderRow {
  readonly relPath: string;
  readonly absPath: string;
}

interface StoreSnapshot {
  readonly documents: ReadonlyArray<MigrateStoreDocumentRow>;
  readonly folders: ReadonlyArray<MigrateStoreFolderRow>;
}

interface ScannedFile {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly content: string;
  readonly stableId: string | null;
  readonly hasFrontmatterBlock: boolean;
}

const migrateError = (
  code: MigrateStoreErrorCode,
  path?: string,
  detail?: string,
): MigrateStoreError =>
  new MigrateStoreError({
    code,
    ...(path === undefined ? {} : { path }),
    ...(detail === undefined ? {} : { detail }),
  });

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? `: ${cause.message}` : `: ${String(cause)}`;

const sameLocation = (left: string, right: string): boolean =>
  NodePath.resolve(left) === NodePath.resolve(right);

const absoluteFor = (contextsRoot: string, relPath: string): string =>
  relPath === "" ? contextsRoot : NodePath.resolve(contextsRoot, ...relPath.split("/"));

const isInsideOrEqual = (parent: string, child: string): boolean => {
  const relative = NodePath.relative(parent, NodePath.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const linkedStableIds = (content: string): ReadonlyArray<string> => {
  const ids: Array<string> = [];
  for (const match of content.matchAll(new RegExp(DOC_LINK_SOURCE, "g"))) {
    const id = match[1];
    if (id !== undefined) ids.push(id.toLowerCase());
  }
  return ids;
};

const compareRelPaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const scanFiles = (
  contextsRoot: string,
): Effect.Effect<ReadonlyArray<ScannedFile>, MigrateStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const contextsExists = await NodeFSP.stat(contextsRoot).then(
        () => true,
        () => false,
      );
      if (!contextsExists) {
        throw migrateError("store_missing", contextsRoot);
      }
      const files: Array<ScannedFile> = [];
      let depthSkipped = 0;
      const visit = async (absDir: string, relDir: string, depth: number): Promise<void> => {
        if (files.length >= MAX_FILES) return;
        const entries = await NodeFSP.readdir(absDir, { withFileTypes: true });
        entries.sort((left, right) => compareRelPaths(left.name, right.name));
        for (const entry of entries) {
          if (files.length >= MAX_FILES) return;
          const absPath = NodePath.join(absDir, entry.name);
          const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
          if (entry.isDirectory()) {
            if (depth + 1 > MAX_DEPTH) {
              depthSkipped += 1;
              continue;
            }
            await visit(absPath, relPath, depth + 1);
            continue;
          }
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith(DOCUMENT_EXTENSION)) continue;
          const [stat, content] = await Promise.all([
            NodeFSP.stat(absPath),
            NodeFSP.readFile(absPath, "utf8"),
          ]);
          files.push({
            relPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            content,
            stableId: Frontmatter.readStableId(content),
            hasFrontmatterBlock: Frontmatter.scanFrontmatter(content) !== null,
          });
        }
      };
      await visit(contextsRoot, "", 1);
      if (depthSkipped > 0) {
        throw migrateError(
          "file_scan_failed",
          contextsRoot,
          `: ${depthSkipped} directory(ies) are deeper than ${MAX_DEPTH}`,
        );
      }
      return files;
    },
    catch: (cause) =>
      isMigrateStoreError(cause)
        ? cause
        : migrateError("file_scan_failed", contextsRoot, describeCause(cause)),
  });

const readDatabase = (root: string): Effect.Effect<StoreSnapshot, MigrateStoreError> =>
  Effect.try({
    try: () => {
      const databasePath = NodePath.join(root, DOCS_STORE_DATABASE_FILENAME);
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        const documents = database
          .prepare(
            "SELECT stable_id AS stableId, rel_path AS relPath, abs_path AS absPath FROM docs",
          )
          .all()
          .map((row) => ({
            stableId: typeof row["stableId"] === "string" ? row["stableId"] : "",
            relPath: typeof row["relPath"] === "string" ? row["relPath"] : "",
            absPath: typeof row["absPath"] === "string" ? row["absPath"] : "",
          }));
        const folders = database
          .prepare("SELECT rel_path AS relPath, abs_path AS absPath FROM folders")
          .all()
          .map((row) => ({
            relPath: typeof row["relPath"] === "string" ? row["relPath"] : "",
            absPath: typeof row["absPath"] === "string" ? row["absPath"] : "",
          }));
        return { documents, folders };
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      migrateError(
        "database_unavailable",
        NodePath.join(root, DOCS_STORE_DATABASE_FILENAME),
        describeCause(cause),
      ),
  });

const buildReport = (
  root: string,
  contextsRoot: string,
  files: ReadonlyArray<ScannedFile>,
  database: StoreSnapshot,
  generatedAt: string,
): MigrateStoreReport => {
  const fileRelPaths = new Set(files.map((file) => file.relPath));
  const rowsByPath = new Map(database.documents.map((row) => [row.relPath, row]));

  const unregisteredFiles = files
    .filter((file) => !rowsByPath.has(file.relPath))
    .map((file) => file.relPath)
    .sort(compareRelPaths);
  const filesWithoutStableId = files
    .filter((file) => file.stableId === null)
    .map((file) => file.relPath)
    .sort(compareRelPaths);
  const filesNeedingFrontmatterBlock = files
    .filter((file) => !file.hasFrontmatterBlock)
    .map((file) => file.relPath)
    .sort(compareRelPaths);

  const dbRowsWithoutFiles = database.documents
    .filter((row) => !fileRelPaths.has(row.relPath))
    .map((row) => ({ stableId: row.stableId, relPath: row.relPath }))
    .sort((left, right) => compareRelPaths(left.relPath, right.relPath));

  const absPathRewrites: Array<MigrateStoreAbsPathRewrite> = [];
  // OpenContext writes `contexts\a/b.md` on Windows; only a different location is a rewrite.
  for (const row of database.documents) {
    const to = absoluteFor(contextsRoot, row.relPath);
    if (!sameLocation(row.absPath, to)) {
      absPathRewrites.push({ table: "docs", relPath: row.relPath, from: row.absPath, to });
    }
  }
  for (const row of database.folders) {
    const to = absoluteFor(contextsRoot, row.relPath);
    if (!sameLocation(row.absPath, to)) {
      absPathRewrites.push({ table: "folders", relPath: row.relPath, from: row.absPath, to });
    }
  }
  absPathRewrites.sort(
    (left, right) =>
      compareRelPaths(left.table, right.table) || compareRelPaths(left.relPath, right.relPath),
  );

  const filesById = new Map<string, Array<string>>();
  for (const file of files) {
    if (file.stableId === null) continue;
    const group = filesById.get(file.stableId);
    if (group === undefined) filesById.set(file.stableId, [file.relPath]);
    else group.push(file.relPath);
  }
  const duplicates: Array<MigrateStoreDuplicate> = [];
  for (const [stableId, relPaths] of filesById) {
    if (relPaths.length < 2) continue;
    duplicates.push({ stableId, relPaths: relPaths.slice().sort(compareRelPaths) });
  }
  duplicates.sort((left, right) => compareRelPaths(left.stableId, right.stableId));

  const referenced = new Set<string>();
  for (const file of files) {
    for (const id of linkedStableIds(file.content)) referenced.add(id);
  }
  const known = new Set<string>();
  for (const row of database.documents) if (row.stableId.length > 0) known.add(row.stableId);
  for (const file of files) if (file.stableId !== null) known.add(file.stableId);
  const danglingLinks = Array.from(referenced)
    .filter((id) => !known.has(id))
    .sort(compareRelPaths);

  return {
    kind: MIGRATE_STORE_REPORT_KIND,
    root,
    contextsRoot,
    generatedAt,
    fileCount: files.length,
    documentRowCount: database.documents.length,
    folderRowCount: database.folders.length,
    unregisteredFiles,
    filesWithoutStableId,
    filesNeedingFrontmatterBlock,
    dbRowsWithoutFiles,
    absPathRewrites,
    duplicates,
    danglingLinks,
    files: files
      .map((file) => ({ relPath: file.relPath, size: file.size, mtimeMs: file.mtimeMs }))
      .sort((left, right) => compareRelPaths(left.relPath, right.relPath)),
    warnings: [],
  };
};

/** True for the shape of a report this module writes; the CLI uses it on JSON input. */
export const isMigrateStoreReport = (value: unknown): value is MigrateStoreReport => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["kind"] === MIGRATE_STORE_REPORT_KIND &&
    typeof candidate["root"] === "string" &&
    Array.isArray(candidate["files"]) &&
    Array.isArray(candidate["absPathRewrites"])
  );
};

const reportIsCurrent = (
  plan: MigrateStoreReport,
  report: MigrateStoreReport,
): Effect.Effect<void, MigrateStoreError> => {
  if (!isMigrateStoreReport(report) || NodePath.resolve(report.root) !== plan.root) {
    return Effect.fail(
      migrateError(
        "report_root_mismatch",
        plan.root,
        `: the report root is "${String(report.root)}"`,
      ),
    );
  }
  const before = new Map(report.files.map((file) => [file.relPath, file]));
  const after = new Map(plan.files.map((file) => [file.relPath, file]));
  const changed: Array<string> = [];
  for (const [relPath, fingerprint] of after) {
    const previous = before.get(relPath);
    if (
      previous === undefined ||
      previous.size !== fingerprint.size ||
      previous.mtimeMs !== fingerprint.mtimeMs
    ) {
      changed.push(relPath);
    }
  }
  for (const relPath of before.keys()) {
    if (!after.has(relPath)) changed.push(relPath);
  }
  if (changed.length === 0) return Effect.void;
  const shown = changed.slice().sort(compareRelPaths).slice(0, 10).join(", ");
  const more = changed.length > 10 ? ` and ${changed.length - 10} more` : "";
  return Effect.fail(
    migrateError(
      "store_changed_since_dry_run",
      plan.root,
      `: ${changed.length} file(s) changed (${shown}${more})`,
    ),
  );
};

/** Reads the store and produces the dry-run report; writes nothing. */
export const inspectStore = Effect.fn("migrateStore.inspectStore")(function* (rootInput: string) {
  const root = NodePath.resolve(rootInput);
  const contextsRoot = NodePath.join(root, DOCS_STORE_CONTEXTS_DIRECTORY);
  const files = yield* scanFiles(contextsRoot);
  const database = yield* readDatabase(root);
  const generatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const warnings: Array<string> = [];
  if (files.length >= MAX_FILES) {
    warnings.push(`Only the first ${MAX_FILES} document files were inspected.`);
  }
  return { ...buildReport(root, contextsRoot, files, database, generatedAt), warnings };
});

const backupTimestamp = (at: string): string => at.replace(/[:.]/g, "-").replace(/\+00:00$/, "Z");

const backupDirectories = (root: string, at: string): ReadonlyArray<string> => {
  const base = `${root}.backup-${backupTimestamp(at)}`;
  return [base, ...Array.from({ length: 9 }, (_, index) => `${base}-${index + 2}`)];
};

const backupStore = (
  root: string,
  plan: MigrateStoreReport,
  at: string,
): Effect.Effect<MigrateStoreBackup, MigrateStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const contextsRoot = NodePath.join(root, DOCS_STORE_CONTEXTS_DIRECTORY);
      const databasePath = NodePath.join(root, DOCS_STORE_DATABASE_FILENAME);
      let directory: string | undefined;
      for (const candidate of backupDirectories(root, at)) {
        const taken = await NodeFSP.access(candidate).then(
          () => true,
          () => false,
        );
        if (!taken) {
          directory = candidate;
          break;
        }
      }
      if (directory === undefined) {
        throw migrateError(
          "backup_failed",
          `${root}.backup-${backupTimestamp(at)}`,
          ": no free name",
        );
      }
      const target = directory;
      try {
        await NodeFSP.mkdir(target);
        await NodeFSP.cp(contextsRoot, NodePath.join(target, DOCS_STORE_CONTEXTS_DIRECTORY), {
          recursive: true,
        });
        const databaseCopy = NodePath.join(target, DOCS_STORE_DATABASE_FILENAME);
        await NodeFSP.copyFile(databasePath, databaseCopy);
        for (const suffix of ["-wal", "-shm"]) {
          const sidecar = `${databasePath}${suffix}`;
          const sidecarExists = await NodeFSP.access(sidecar).then(
            () => true,
            () => false,
          );
          if (sidecarExists) await NodeFSP.copyFile(sidecar, `${databaseCopy}${suffix}`);
        }

        const databaseSize = (await NodeFSP.stat(databasePath)).size;
        const copiedDatabaseSize = (await NodeFSP.stat(databaseCopy)).size;
        if (databaseSize !== copiedDatabaseSize) {
          throw migrateError(
            "backup_failed",
            target,
            `: the database copy is ${copiedDatabaseSize} bytes, the original ${databaseSize}`,
          );
        }
        for (const file of plan.files) {
          const copied = NodePath.join(
            target,
            DOCS_STORE_CONTEXTS_DIRECTORY,
            ...file.relPath.split("/"),
          );
          const copiedSize = await NodeFSP.stat(copied).then(
            (stat) => stat.size,
            () => -1,
          );
          if (copiedSize !== file.size) {
            throw migrateError("backup_failed", target, `: "${file.relPath}" was not copied`);
          }
        }
        return { directory: target, databasePath: databaseCopy, files: plan.files.length };
      } catch (cause) {
        await NodeFSP.rm(target, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) =>
      isMigrateStoreError(cause)
        ? cause
        : migrateError("backup_failed", root, describeCause(cause)),
  });

const rewriteAbsPaths = (
  root: string,
  rewrites: ReadonlyArray<MigrateStoreAbsPathRewrite>,
  at: string,
): Effect.Effect<void, MigrateStoreError> => {
  if (rewrites.length === 0) return Effect.void;
  return Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(root, DOCS_STORE_DATABASE_FILENAME),
      );
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        const updateDocs = database.prepare(
          "UPDATE docs SET abs_path = ?, updated_at = ? WHERE rel_path = ?",
        );
        const updateFolders = database.prepare(
          "UPDATE folders SET abs_path = ?, updated_at = ? WHERE rel_path = ?",
        );
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const rewrite of rewrites) {
            if (rewrite.table === "docs") updateDocs.run(rewrite.to, at, rewrite.relPath);
            else updateFolders.run(rewrite.to, at, rewrite.relPath);
          }
          database.exec("COMMIT");
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      isMigrateStoreError(cause)
        ? cause
        : migrateError("migration_failed", root, describeCause(cause)),
  });
};

const verifyStore = Effect.fn("migrateStore.verifyStore")(function* (
  root: string,
  plan: MigrateStoreReport,
  backupDirectory: string | null,
) {
  const contextsRoot = NodePath.join(root, DOCS_STORE_CONTEXTS_DIRECTORY);
  const files = yield* scanFiles(contextsRoot);
  const database = yield* readDatabase(root);
  const issues: Array<MigrateStoreIssue> = [];
  const warnings: Array<MigrateStoreIssue> = [];
  const rowsByPath = new Map(database.documents.map((row) => [row.relPath, row]));
  const filesByPath = new Map(files.map((file) => [file.relPath, file]));

  for (const file of files) {
    const row = rowsByPath.get(file.relPath);
    if (row === undefined) {
      issues.push({ code: "unregistered_file", detail: file.relPath });
      continue;
    }
    if (file.stableId !== row.stableId) {
      issues.push({
        code: "frontmatter_id_mismatch",
        detail: `${file.relPath}: frontmatter ${file.stableId ?? "(none)"} but row ${row.stableId}`,
      });
    }
    if (backupDirectory === null) continue;
    const before = NodePath.join(
      backupDirectory,
      DOCS_STORE_CONTEXTS_DIRECTORY,
      ...file.relPath.split("/"),
    );
    const beforeContent = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(before, "utf8"),
      catch: (cause) => migrateError("migration_failed", before, describeCause(cause)),
    }).pipe(Effect.option);
    if (Option.isNone(beforeContent)) {
      issues.push({ code: "backup_file_missing", detail: file.relPath });
      continue;
    }
    const expected =
      Frontmatter.readStableId(beforeContent.value) === row.stableId
        ? beforeContent.value
        : Frontmatter.writeStableId(beforeContent.value, row.stableId);
    if (expected !== file.content) {
      issues.push({ code: "file_bytes_changed", detail: file.relPath });
    }
  }

  const filesById = new Map<string, Array<string>>();
  for (const file of files) {
    if (file.stableId === null) continue;
    const group = filesById.get(file.stableId);
    if (group === undefined) filesById.set(file.stableId, [file.relPath]);
    else group.push(file.relPath);
  }
  for (const [stableId, relPaths] of filesById) {
    if (relPaths.length < 2) continue;
    issues.push({
      code: "duplicate_stable_id",
      detail: `${stableId}: ${relPaths.slice().sort(compareRelPaths).join(", ")}`,
    });
  }

  for (const row of database.documents) {
    if (!filesByPath.has(row.relPath)) {
      warnings.push({ code: "row_without_file", detail: row.relPath });
    }
  }

  const absoluteRows = [
    ...database.documents.map((row) => ({ table: "docs" as const, ...row })),
    ...database.folders.map((row) => ({ table: "folders" as const, stableId: "", ...row })),
  ];
  for (const row of absoluteRows) {
    const expected = absoluteFor(contextsRoot, row.relPath);
    if (!sameLocation(row.absPath, expected)) {
      issues.push({
        code: "abs_path_mismatch",
        detail: `${row.table} "${row.relPath}": "${row.absPath}" != "${expected}"`,
      });
    }
    if (!isInsideOrEqual(contextsRoot, row.absPath)) {
      issues.push({
        code: "abs_path_outside_root",
        detail: `${row.table} "${row.relPath}": "${row.absPath}"`,
      });
    }
  }

  const referenced = new Set<string>();
  for (const file of files) {
    for (const id of linkedStableIds(file.content)) referenced.add(id);
  }
  const resolved = new Set(database.documents.map((row) => row.stableId.toLowerCase()));
  const preexisting = new Set(plan.danglingLinks.map((id) => id.toLowerCase()));
  for (const id of Array.from(referenced).sort(compareRelPaths)) {
    if (resolved.has(id)) continue;
    if (preexisting.has(id)) warnings.push({ code: "dangling_link_preexisting", detail: id });
    else issues.push({ code: "dangling_link_added", detail: id });
  }

  return {
    ok: issues.length === 0,
    checkedFiles: files.length,
    checkedRows: database.documents.length,
    issues,
    warnings,
  };
});

const registrationsOf = (
  plan: MigrateStoreReport,
  database: StoreSnapshot,
): ReadonlyArray<MigrateStoreDocumentRegistration> => {
  const rowsByPath = new Map(database.documents.map((row) => [row.relPath, row]));
  return plan.unregisteredFiles.map((relPath) => ({
    relPath,
    stableId: rowsByPath.get(relPath)?.stableId ?? "",
  }));
};

const frontmatterWritesOf = (
  plan: MigrateStoreReport,
  database: StoreSnapshot,
): ReadonlyArray<MigrateStoreFrontmatterWrite> => {
  const rowsByPath = new Map(database.documents.map((row) => [row.relPath, row]));
  const withBlock = new Set(plan.filesNeedingFrontmatterBlock);
  return plan.filesWithoutStableId.map((relPath) => ({
    relPath,
    stableId: rowsByPath.get(relPath)?.stableId ?? "",
    addedBlock: withBlock.has(relPath),
  }));
};

/** Executes the migration after a dry run of the same root: validates the report, backs up the
 * database and every file, registers documents, writes `stable_id`, rewrites `abs_path`, then
 * verifies. Refuses a changed store before any write; never deletes a file. */
export const migrateStore = Effect.fn("migrateStore.migrateStore")(function* (
  options: MigrateStoreOptions,
) {
  const reconciler = yield* DocsReconciler;
  const root = NodePath.resolve(options.root);
  const plan = yield* inspectStore(root);
  yield* reportIsCurrent(plan, options.report);

  const pending: boolean =
    plan.unregisteredFiles.length > 0 ||
    plan.filesWithoutStableId.length > 0 ||
    plan.absPathRewrites.length > 0 ||
    plan.duplicates.length > 0;

  if (!pending) {
    const verification = yield* verifyStore(root, plan, null);
    return {
      status: "up_to_date" as const,
      plan,
      backupDirectory: null,
      backupDatabasePath: null,
      backedUpFiles: 0,
      registeredDocuments: [],
      frontmatterWrites: [],
      absPathRewrites: [],
      verification,
      warnings: plan.warnings,
    };
  }

  const at = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const backup = yield* backupStore(root, plan, at);
  const reconcileReport = yield* reconciler
    .reconcile()
    .pipe(Effect.mapError((cause) => migrateError("migration_failed", root, describeCause(cause))));
  yield* rewriteAbsPaths(root, plan.absPathRewrites, at);
  const verification = yield* verifyStore(root, plan, backup.directory);
  const database = yield* readDatabase(root);
  const warnings: Array<string> = [
    ...plan.warnings,
    ...reconcileReport.warnings,
    ...plan.dbRowsWithoutFiles.map(
      (row) => `Row "${row.relPath}" has no file; the row is kept and left for the reconciler.`,
    ),
  ];
  return {
    status: "migrated" as const,
    plan,
    backupDirectory: backup.directory,
    backupDatabasePath: backup.databasePath,
    backedUpFiles: backup.files,
    registeredDocuments: registrationsOf(plan, database),
    frontmatterWrites: frontmatterWritesOf(plan, database),
    absPathRewrites: plan.absPathRewrites,
    verification,
    warnings,
  };
});
