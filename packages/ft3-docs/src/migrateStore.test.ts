// @effect-diagnostics nodeBuiltinImport:off - the tests build a legacy document store on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { inspectStore, migrateStore, type MigrateStoreReport } from "./migrateStore.ts";
import * as DocsReconciler from "./reconciler.ts";
import * as DocsStore from "./store.ts";

// The repository never carries real document ids; fixtures use the nil UUID and
// ids generated while the test runs.
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const FIXTURE_TIME = "2026-01-01T00:00:00.000Z";
const CONTEXTS = "contexts";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const newId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

interface Fixture {
  readonly adoptId: string;
  readonly goneId: string;
  readonly missingLinkId: string;
  readonly contents: ReadonlyMap<string, string>;
}

const STALE_CONTEXTS_ROOT = NodePath.join("legacy-root", CONTEXTS);

const staleAbsolute = (relPath: string): string =>
  NodePath.join(STALE_CONTEXTS_ROOT, ...relPath.split("/"));

const prepareLegacyStore = (root: string): Fixture => {
  const contextsRoot = NodePath.join(root, CONTEXTS);
  const adoptId = newId();
  const goneId = newId();
  const missingLinkId = newId();
  const contents = new Map<string, string>([
    [
      "notes/kept.md",
      `---\nstable_id: ${NIL_ID}\n---\n# Kept\n\nSee oc://doc/${NIL_ID} and oc://doc/${missingLinkId}.\n`,
    ],
    ["notes/adopt.md", "---\r\ntitle: Adopt\r\n---\r\n# Adopt\r\n\r\nbody\r\n"],
    ["notes/new.md", "# New\n\nno frontmatter\n"],
    ["notes/copy.md", `---\nstable_id: ${NIL_ID}\n---\n# Copy\n`],
  ]);
  for (const [relPath, content] of contents) {
    const absolute = NodePath.join(contextsRoot, ...relPath.split("/"));
    NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
    NodeFS.writeFileSync(absolute, content, "utf8");
  }

  // The schema of OpenContext 0.2.2, with stale absolute paths and one row whose
  // file never existed, exactly as an external `oc` store can look.
  const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencontext.db"));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`CREATE TABLE folders (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rel_path TEXT NOT NULL UNIQUE,
      abs_path TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.exec(`CREATE TABLE docs (
      id INTEGER PRIMARY KEY,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rel_path TEXT NOT NULL UNIQUE,
      abs_path TEXT NOT NULL,
      description TEXT DEFAULT '',
      stable_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.exec("CREATE UNIQUE INDEX idx_docs_stable_id ON docs(stable_id)");
    const insertFolder = database.prepare(
      "INSERT INTO folders (id, parent_id, name, rel_path, abs_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)",
    );
    insertFolder.run(1, null, "", "", STALE_CONTEXTS_ROOT, FIXTURE_TIME, FIXTURE_TIME);
    insertFolder.run(2, 1, "notes", "notes", staleAbsolute("notes"), FIXTURE_TIME, FIXTURE_TIME);
    const insertDoc = database.prepare(
      "INSERT INTO docs (id, folder_id, name, rel_path, abs_path, description, stable_id, created_at, updated_at) VALUES (?, 2, ?, ?, ?, '', ?, ?, ?)",
    );
    insertDoc.run(
      1,
      "kept.md",
      "notes/kept.md",
      staleAbsolute("notes/kept.md"),
      NIL_ID,
      FIXTURE_TIME,
      FIXTURE_TIME,
    );
    insertDoc.run(
      2,
      "adopt.md",
      "notes/adopt.md",
      staleAbsolute("notes/adopt.md"),
      adoptId,
      FIXTURE_TIME,
      FIXTURE_TIME,
    );
    insertDoc.run(
      3,
      "gone.md",
      "notes/gone.md",
      staleAbsolute("notes/gone.md"),
      goneId,
      FIXTURE_TIME,
      FIXTURE_TIME,
    );
  } finally {
    database.close();
  }
  return { adoptId, goneId, missingLinkId, contents };
};

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-migrate-")));

const removeStore = (root: string) =>
  Effect.promise(async () => {
    const parent = NodePath.dirname(root);
    const base = NodePath.basename(root);
    for (const entry of await NodeFSP.readdir(parent)) {
      if (entry === base || entry.startsWith(`${base}.backup-`)) {
        await NodeFSP.rm(NodePath.join(parent, entry), { recursive: true, force: true });
      }
    }
  });

const testLayer = (root: string) =>
  Layer.provideMerge(
    DocsReconciler.layer({ root }),
    Layer.mergeAll(
      DocsStore.layer({ root }).pipe(Layer.provide(cryptoLayer)),
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
  );

const withMigrator = <A, E>(
  use: (root: string, fixture: Fixture) => Effect.Effect<A, E, DocsReconciler.DocsReconciler>,
) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    const fixture = yield* Effect.sync(() => prepareLegacyStore(root));
    return yield* use(root, fixture).pipe(
      Effect.provide(testLayer(root)),
      Effect.ensuring(removeStore(root)),
    );
  });

const contextPath = (root: string, relPath: string): string =>
  NodePath.join(root, CONTEXTS, ...relPath.split("/"));

const readText = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));

const exists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );

const backupDirectories = (root: string) =>
  Effect.promise(async () => {
    const parent = NodePath.dirname(root);
    const base = NodePath.basename(root);
    return (await NodeFSP.readdir(parent)).filter((entry) => entry.startsWith(`${base}.backup-`));
  });

interface DatabaseState {
  readonly documents: ReadonlyArray<{ readonly relPath: string; readonly absPath: string }>;
  readonly folders: ReadonlyArray<{ readonly relPath: string; readonly absPath: string }>;
}

const readDatabaseState = (root: string) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencontext.db"), {
      readOnly: true,
    });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const documents = database
        .prepare("SELECT rel_path AS relPath, abs_path AS absPath FROM docs ORDER BY rel_path")
        .all()
        .map((row) => ({
          relPath: String(row["relPath"]),
          absPath: String(row["absPath"]),
        }));
      const folders = database
        .prepare("SELECT rel_path AS relPath, abs_path AS absPath FROM folders ORDER BY rel_path")
        .all()
        .map((row) => ({
          relPath: String(row["relPath"]),
          absPath: String(row["absPath"]),
        }));
      return { documents, folders } satisfies DatabaseState;
    } finally {
      database.close();
    }
  });

const assertReportLists = (report: MigrateStoreReport, fixture: Fixture): void => {
  assert.deepEqual(report.unregisteredFiles, ["notes/copy.md", "notes/new.md"]);
  assert.deepEqual(report.filesWithoutStableId, ["notes/adopt.md", "notes/new.md"]);
  assert.deepEqual(report.filesNeedingFrontmatterBlock, ["notes/new.md"]);
  assert.deepEqual(
    report.dbRowsWithoutFiles.map((row) => row.relPath),
    ["notes/gone.md"],
  );
  assert.equal(report.duplicates.length, 1);
  const duplicate = report.duplicates[0];
  assert.equal(duplicate?.stableId, NIL_ID);
  assert.deepEqual(duplicate?.relPaths, ["notes/copy.md", "notes/kept.md"]);
  assert.deepEqual(report.danglingLinks, [fixture.missingLinkId]);
  // Two document rows (kept, adopt) and one orphan row plus two folder rows.
  assert.equal(report.absPathRewrites.filter((rewrite) => rewrite.table === "docs").length, 3);
  assert.equal(report.absPathRewrites.filter((rewrite) => rewrite.table === "folders").length, 2);
  assert.equal(report.fileCount, 4);
  assert.equal(report.documentRowCount, 3);
  assert.equal(report.folderRowCount, 2);
};

describe("migrateStore", () => {
  it.effect("dry run reports the plan and writes nothing", () =>
    withMigrator((root, fixture) =>
      Effect.gen(function* () {
        const databaseBefore = yield* readDatabaseState(root);
        const keptBefore = yield* readText(contextPath(root, "notes/kept.md"));
        const adoptBefore = yield* readText(contextPath(root, "notes/adopt.md"));
        const newBefore = yield* readText(contextPath(root, "notes/new.md"));

        const report = yield* inspectStore(root);

        assertReportLists(report, fixture);
        assert.deepEqual(yield* readDatabaseState(root), databaseBefore);
        assert.equal(yield* readText(contextPath(root, "notes/kept.md")), keptBefore);
        assert.equal(yield* readText(contextPath(root, "notes/adopt.md")), adoptBefore);
        assert.equal(yield* readText(contextPath(root, "notes/new.md")), newBefore);
        assert.deepEqual(yield* backupDirectories(root), []);
      }),
    ),
  );

  it.effect("real run registers, writes stable_id, rewrites abs_path and verifies", () =>
    withMigrator((root, fixture) =>
      Effect.gen(function* () {
        const report = yield* inspectStore(root);
        const result = yield* migrateStore({ root, report });

        assert.equal(result.status, "migrated");
        assert.isTrue(result.verification.ok);
        assert.deepEqual(result.verification.issues, []);
        assert.equal(result.registeredDocuments.length, 2);
        assert.deepEqual(result.registeredDocuments.map((entry) => entry.relPath).sort(), [
          "notes/copy.md",
          "notes/new.md",
        ]);
        for (const entry of result.registeredDocuments)
          assert.match(entry.stableId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(
          result.registeredDocuments.map((entry) => entry.stableId).sort(),
          [...new Set(result.registeredDocuments.map((entry) => entry.stableId))].sort(),
        );
        assert.deepEqual(
          result.frontmatterWrites.map((entry) => [entry.relPath, entry.addedBlock]),
          [
            ["notes/adopt.md", false],
            ["notes/new.md", true],
          ],
        );

        const after = yield* inspectStore(root);
        assert.deepEqual(after.unregisteredFiles, []);
        assert.deepEqual(after.filesWithoutStableId, []);
        assert.deepEqual(after.absPathRewrites, []);
        assert.deepEqual(after.duplicates, []);
        // The dangling link was already dangling before the migration.
        assert.deepEqual(after.danglingLinks, [fixture.missingLinkId]);

        // Byte preservation: only the stable_id line/block was inserted.
        assert.equal(
          yield* readText(contextPath(root, "notes/adopt.md")),
          `---\r\nstable_id: ${fixture.adoptId}\r\ntitle: Adopt\r\n---\r\n# Adopt\r\n\r\nbody\r\n`,
        );
        assert.equal(
          yield* readText(contextPath(root, "notes/kept.md")),
          fixture.contents.get("notes/kept.md"),
        );

        const database = yield* readDatabaseState(root);
        const contextsRoot = NodePath.join(root, CONTEXTS);
        for (const row of [...database.documents, ...database.folders]) {
          assert.equal(row.absPath, NodePath.resolve(contextsRoot, ...row.relPath.split("/")));
        }
        // The row without a file is kept; no file was deleted.
        assert.deepEqual(
          database.documents.map((row) => row.relPath),
          ["notes/adopt.md", "notes/copy.md", "notes/gone.md", "notes/kept.md", "notes/new.md"],
        );
        assert.equal(yield* exists(contextPath(root, "notes/kept.md")), true);
      }),
    ),
  );

  it.effect("backs up the database and every file it will touch", () =>
    withMigrator((root, fixture) =>
      Effect.gen(function* () {
        const report = yield* inspectStore(root);
        const result = yield* migrateStore({ root, report });
        assert.isNotNull(result.backupDirectory);
        const backupDirectory = result.backupDirectory ?? "";
        assert.isTrue(yield* exists(backupDirectory));

        const backupDatabase = NodePath.join(backupDirectory, "opencontext.db");
        assert.isTrue(yield* exists(backupDatabase));
        const backupRows = yield* Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(backupDatabase, { readOnly: true });
          try {
            return database.prepare("SELECT abs_path AS absPath FROM docs ORDER BY rel_path").all();
          } finally {
            database.close();
          }
        });
        // The backup keeps the pre-migration absolute paths.
        assert.equal(String(backupRows[0]?.["absPath"]), staleAbsolute("notes/adopt.md"));

        for (const file of report.files) {
          const original = fixture.contents.get(file.relPath);
          assert.isDefined(original);
          const copied = NodePath.join(backupDirectory, CONTEXTS, ...file.relPath.split("/"));
          assert.equal(yield* readText(copied), original);
        }
        // The rewritten file in the store differs from its backup.
        assert.equal(
          yield* readText(contextPath(root, "notes/adopt.md")),
          `---\r\nstable_id: ${fixture.adoptId}\r\ntitle: Adopt\r\n---\r\n# Adopt\r\n\r\nbody\r\n`,
        );
      }),
    ),
  );

  it.effect("refuses to write when a file changed after the dry run", () =>
    withMigrator((root) =>
      Effect.gen(function* () {
        const report = yield* inspectStore(root);
        const databaseBefore = yield* readDatabaseState(root);
        const adoptPath = contextPath(root, "notes/adopt.md");
        const adoptBefore = yield* readText(adoptPath);
        yield* Effect.promise(async () => {
          const stat = await NodeFSP.stat(adoptPath);
          const seconds = stat.mtimeMs / 1000 + 5;
          await NodeFSP.utimes(adoptPath, seconds, seconds);
        });

        const error = yield* migrateStore({ root, report }).pipe(Effect.flip);

        assert.equal(error.code, "store_changed_since_dry_run");
        assert.include(error.message, "notes/adopt.md");
        assert.deepEqual(yield* readDatabaseState(root), databaseBefore);
        assert.equal(yield* readText(adoptPath), adoptBefore);
        assert.deepEqual(yield* backupDirectories(root), []);
      }),
    ),
  );

  it.effect("is idempotent on a second run", () =>
    withMigrator((root) =>
      Effect.gen(function* () {
        const firstReport = yield* inspectStore(root);
        const first = yield* migrateStore({ root, report: firstReport });
        assert.equal(first.status, "migrated");

        const contentBefore = yield* readText(contextPath(root, "notes/kept.md"));
        const secondReport = yield* inspectStore(root);
        assert.deepEqual(secondReport.unregisteredFiles, []);
        assert.deepEqual(secondReport.filesWithoutStableId, []);
        assert.deepEqual(secondReport.absPathRewrites, []);
        assert.deepEqual(secondReport.duplicates, []);

        const second = yield* migrateStore({ root, report: secondReport });
        assert.equal(second.status, "up_to_date");
        assert.isNull(second.backupDirectory);
        assert.isTrue(second.verification.ok);
        assert.deepEqual(second.registeredDocuments, []);
        assert.deepEqual(second.frontmatterWrites, []);
        assert.equal(yield* readText(contextPath(root, "notes/kept.md")), contentBefore);
        assert.deepEqual(yield* backupDirectories(root), [
          NodePath.basename(first.backupDirectory ?? ""),
        ]);
      }),
    ),
  );
});
