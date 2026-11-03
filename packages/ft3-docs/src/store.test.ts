// @effect-diagnostics nodeBuiltinImport:off - the test creates a document store on disk.
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DocsStore from "./store.ts";

// The repository never carries real document ids; tests use the nil UUID.
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const FIXTURE_TIME = "2026-01-01T00:00:00.000Z";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const storeLayer = (root: string) => DocsStore.layer({ root }).pipe(Layer.provide(cryptoLayer));

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-store-")));

const removeRoot = (root: string) =>
  Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));

const withStore = <A, E>(
  use: (store: DocsStore.DocsStore["Service"], root: string) => Effect.Effect<A, E>,
  setup?: (root: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    if (setup !== undefined) yield* setup(root);
    return yield* Effect.gen(function* () {
      const store = yield* DocsStore.DocsStore;
      return yield* use(store, root);
    }).pipe(Effect.provide(storeLayer(root)), Effect.ensuring(removeRoot(root)));
  });

const fileExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );

const readText = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));

const writeText = (path: string, content: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, content, "utf8");
  });

const CONTEXTS = "contexts";

const contextPath = (root: string, relPath: string) =>
  NodePath.join(root, CONTEXTS, ...relPath.split("/"));

/**
 * The schema of OpenContext 0.2.2, written independently of the store so the
 * compatibility test fails when either side drifts.
 */
const OPENCONTEXT_SCHEMA = [
  `CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    abs_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE docs (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    abs_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    stable_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX idx_docs_stable_id ON docs(stable_id)",
];

function prepareExternalStore(root: string): void {
  const contextsRoot = NodePath.join(root, CONTEXTS);
  const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencontext.db"));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const statement of OPENCONTEXT_SCHEMA) database.exec(statement);
    const insertFolder = database.prepare(
      "INSERT INTO folders (id, parent_id, name, rel_path, abs_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)",
    );
    insertFolder.run(1, null, "", "", contextsRoot, FIXTURE_TIME, FIXTURE_TIME);
    insertFolder.run(
      2,
      1,
      "notes",
      "notes",
      NodePath.join(contextsRoot, "notes"),
      FIXTURE_TIME,
      FIXTURE_TIME,
    );
    database
      .prepare(
        "INSERT INTO docs (id, folder_id, name, rel_path, abs_path, description, stable_id, created_at, updated_at) VALUES (1, 2, 'plan.md', 'notes/plan.md', ?, '', ?, ?, ?)",
      )
      .run(NodePath.join(contextsRoot, "notes", "plan.md"), NIL_ID, FIXTURE_TIME, FIXTURE_TIME);
  } finally {
    database.close();
  }
}

interface StoreSchema {
  readonly tables: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<string>;
  readonly folderColumns: ReadonlyArray<string>;
  readonly documentColumns: ReadonlyArray<string>;
  readonly folderForeignKeys: ReadonlyArray<string>;
  readonly documentForeignKeys: ReadonlyArray<string>;
  readonly journalMode: string;
}

const column = (rows: ReadonlyArray<unknown>, key: string): ReadonlyArray<string> =>
  rows.map((row) => String((row as Readonly<Record<string, unknown>>)[key]));

const names = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> => column(rows, "name");

const readSchema = (root: string) =>
  Effect.sync((): StoreSchema => {
    const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencontext.db"), {
      readOnly: true,
    });
    try {
      return {
        tables: names(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all(),
        ),
        indexes: names(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all(),
        ),
        folderColumns: names(database.prepare("PRAGMA table_info(folders)").all()),
        documentColumns: names(database.prepare("PRAGMA table_info(docs)").all()),
        folderForeignKeys: column(
          database.prepare("PRAGMA foreign_key_list(folders)").all(),
          "table",
        ),
        documentForeignKeys: column(
          database.prepare("PRAGMA foreign_key_list(docs)").all(),
          "table",
        ),
        journalMode: String(database.prepare("PRAGMA journal_mode").get()?.journal_mode),
      };
    } finally {
      database.close();
    }
  });

describe("DocsStore", () => {
  it.effect("adopts a store created by OpenContext without changing its schema", () =>
    withStore(
      (store, root) =>
        Effect.gen(function* () {
          const found = yield* store.getByStableId(NIL_ID);
          assert.isNotNull(found);
          assert.equal(found.relPath, "notes/plan.md");
          assert.equal(found.name, "plan.md");
          assert.equal(found.description, "");

          const manifest = yield* store.manifest({ folderRelPath: "notes" });
          assert.lengthOf(manifest, 1);
          assert.equal(manifest[0]?.stableId, NIL_ID);
          assert.equal(manifest[0]?.relPath, "notes/plan.md");

          const schema = yield* readSchema(root);
          assert.deepStrictEqual(schema.tables, ["docs", "folders"]);
          assert.deepStrictEqual(schema.indexes, ["idx_docs_stable_id"]);
          assert.deepStrictEqual(schema.folderColumns, [
            "id",
            "parent_id",
            "name",
            "rel_path",
            "abs_path",
            "description",
            "created_at",
            "updated_at",
          ]);
          assert.deepStrictEqual(schema.documentColumns, [
            "id",
            "folder_id",
            "name",
            "rel_path",
            "abs_path",
            "description",
            "stable_id",
            "created_at",
            "updated_at",
          ]);
          assert.deepStrictEqual(schema.folderForeignKeys, ["folders"]);
          assert.deepStrictEqual(schema.documentForeignKeys, ["folders"]);
          assert.equal(schema.journalMode, "delete");
        }),
      (root) =>
        Effect.gen(function* () {
          prepareExternalStore(root);
          yield* writeText(
            contextPath(root, "notes/plan.md"),
            `---\nstable_id: ${NIL_ID}\n---\n\n# Plan\n`,
          );
        }),
    ),
  );

  it.effect("creates, reads, updates, and removes folders and documents", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const project = yield* store.createFolder({ relPath: "projects" });
        assert.equal(project.relPath, "projects");
        assert.equal(project.name, "projects");
        assert.equal(project.parentId, 1);
        yield* store.createFolder({ relPath: "projects/alpha" });

        const document = yield* store.createDoc({
          relPath: "projects/alpha/plan.md",
          content: "# Plan\n",
          description: "First draft",
        });
        assert.equal(document.name, "plan.md");
        assert.equal(document.description, "First draft");

        const byPath = yield* store.getByPath("projects/alpha/plan.md");
        assert.isNotNull(byPath);
        assert.equal(byPath.stableId, document.stableId);
        assert.equal((yield* store.getByStableId(document.stableId))?.relPath, document.relPath);
        assert.isNull(yield* store.getByStableId("99999999-9999-4999-8999-999999999999"));

        assert.deepStrictEqual(
          (yield* store.listFolders("projects")).map((folder) => folder.name),
          ["alpha"],
        );
        assert.deepStrictEqual(
          (yield* store.listDocs("projects/alpha")).map((doc) => doc.name),
          ["plan.md"],
        );
        assert.deepStrictEqual(yield* store.listDocs("projects"), []);

        const described = yield* store.setDescription({
          relPath: "projects/alpha/plan.md",
          description: "Accepted",
        });
        assert.equal(described.description, "Accepted");

        const saved = yield* store.saveDocContent({
          relPath: "projects/alpha/plan.md",
          content: "# Plan v2\n",
        });
        assert.equal(saved.stableId, document.stableId);
        assert.include(
          yield* store.readDocContent({ relPath: "projects/alpha/plan.md" }),
          "# Plan v2",
        );

        const duplicateFolder = yield* Effect.flip(store.createFolder({ relPath: "projects" }));
        assert.equal(duplicateFolder.code, "folder_exists");
        const duplicateDocument = yield* Effect.flip(
          store.createDoc({ relPath: "projects/alpha/plan.md" }),
        );
        assert.equal(duplicateDocument.code, "document_exists");

        yield* store.removeDoc({ relPath: "projects/alpha/plan.md" });
        assert.isNull(yield* store.getByPath("projects/alpha/plan.md"));
        assert.isNull(yield* store.getByStableId(document.stableId));

        const temporary = yield* store.createDoc({ relPath: "projects/temp/note.md" });
        yield* store.removeFolder({ relPath: "projects/temp" });
        assert.isNull(yield* store.getByStableId(temporary.stableId));
        assert.deepStrictEqual(
          (yield* store.listFolders("projects")).map((folder) => folder.name),
          ["alpha"],
        );
      }),
    ),
  );

  it.effect("moves a folder subtree on disk and rewrites its rows in one transaction", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        yield* store.createFolder({ relPath: "projects/alpha/deep" });
        const plan = yield* store.createDoc({
          relPath: "projects/alpha/plan.md",
          content: "# Plan\n",
        });
        const notes = yield* store.createDoc({
          relPath: "projects/alpha/deep/notes.md",
          content: "# Notes\n",
        });
        yield* store.createFolder({ relPath: "projects/beta" });

        yield* store.renameFolder({ relPath: "projects/alpha", name: "gamma" });
        assert.isTrue(yield* fileExists(contextPath(root, "projects/gamma/plan.md")));
        assert.isTrue(yield* fileExists(contextPath(root, "projects/gamma/deep/notes.md")));
        assert.isFalse(yield* fileExists(contextPath(root, "projects/alpha/plan.md")));
        assert.isNull(yield* store.getByPath("projects/alpha/plan.md"));
        assert.equal(
          (yield* store.getByStableId(plan.stableId))?.relPath,
          "projects/gamma/plan.md",
        );
        assert.equal(
          (yield* store.getByStableId(plan.stableId))?.absPath,
          NodePath.resolve(contextPath(root, "projects/gamma/plan.md")),
        );
        const deep = (yield* store.listFolders("projects/gamma")).find(
          (folder) => folder.name === "deep",
        );
        assert.isDefined(deep);
        assert.equal(deep?.relPath, "projects/gamma/deep");
        assert.equal(deep?.absPath, NodePath.resolve(contextPath(root, "projects/gamma/deep")));

        yield* store.moveFolder({ relPath: "projects/gamma", newParentRelPath: "projects/beta" });
        assert.isTrue(yield* fileExists(contextPath(root, "projects/beta/gamma/deep/notes.md")));
        assert.isFalse(yield* fileExists(contextPath(root, "projects/gamma/deep/notes.md")));
        const movedNotes = yield* store.getByStableId(notes.stableId);
        assert.equal(movedNotes?.relPath, "projects/beta/gamma/deep/notes.md");
        assert.equal(
          movedNotes?.absPath,
          NodePath.resolve(contextPath(root, "projects/beta/gamma/deep/notes.md")),
        );

        const beta = (yield* store.listFolders("projects")).find(
          (folder) => folder.name === "beta",
        );
        assert.isDefined(beta);
        const renamed = yield* store.renameDoc({
          relPath: "projects/beta/gamma/plan.md",
          name: "plan-v2.md",
        });
        assert.equal(renamed.stableId, plan.stableId);
        assert.equal(renamed.relPath, "projects/beta/gamma/plan-v2.md");
        assert.isTrue(yield* fileExists(contextPath(root, "projects/beta/gamma/plan-v2.md")));
        assert.isFalse(yield* fileExists(contextPath(root, "projects/beta/gamma/plan.md")));

        const relocated = yield* store.moveDoc({
          relPath: "projects/beta/gamma/deep/notes.md",
          newParentRelPath: "projects/beta",
          newName: "notes.md",
        });
        assert.equal(relocated.stableId, notes.stableId);
        assert.equal(relocated.relPath, "projects/beta/notes.md");
        assert.equal(relocated.folderId, beta?.id);
        assert.isTrue(yield* fileExists(contextPath(root, "projects/beta/notes.md")));

        const nestedMove = yield* Effect.flip(
          store.moveFolder({ relPath: "projects/beta", newParentRelPath: "projects/beta/gamma" }),
        );
        assert.equal(nestedMove.code, "invalid_path");
      }),
    ),
  );

  it.effect("writes a UUIDv4 stable_id into a new document and reads it back", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const document = yield* store.createDoc({ relPath: "notes/plan.md", content: "# Plan\n" });
        assert.match(document.stableId, UUID_V4_PATTERN);
        const file = yield* readText(contextPath(root, "notes/plan.md"));
        assert.include(file, `stable_id: ${document.stableId}`);
        assert.equal((yield* store.getByStableId(document.stableId))?.relPath, "notes/plan.md");

        const saved = yield* store.saveDocContent({
          relPath: "notes/plan.md",
          content: "# Plan v2\n",
        });
        assert.equal(saved.stableId, document.stableId);
        assert.include(
          yield* readText(contextPath(root, "notes/plan.md")),
          `stable_id: ${document.stableId}`,
        );
      }),
    ),
  );

  it.effect("keeps a BOM, CRLF, field order, and an existing stable_id of the source content", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const content = `\uFEFF---\r\nkind: plan\r\nstable_id: "${NIL_ID}"\r\nstatus: draft\r\n---\r\n\r\n# Plan\r\n`;
        const document = yield* store.createDoc({ relPath: "notes/plan.md", content });
        assert.equal(document.stableId, NIL_ID);
        assert.strictEqual(
          yield* readText(contextPath(root, "notes/plan.md")),
          `\uFEFF---\r\nkind: plan\r\nstable_id: ${NIL_ID}\r\nstatus: draft\r\n---\r\n\r\n# Plan\r\n`,
        );

        const duplicate = yield* Effect.flip(
          store.createDoc({ relPath: "notes/copy.md", content }),
        );
        assert.equal(duplicate.code, "duplicate_stable_id");
      }),
    ),
  );

  it.effect("lists a folder manifest recursively, unlimited by default and without abs_path", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.createFolder({ relPath: "bulk" });
        yield* store.createFolder({ relPath: "other" });
        yield* Effect.forEach(
          Array.from({ length: 12 }, (_, index) => index),
          (index) =>
            store.createDoc({
              relPath: `bulk/note-${String(index).padStart(2, "0")}.md`,
              content: `# ${index}\n`,
            }),
          { concurrency: 1 },
        );
        yield* store.createDoc({ relPath: "other/skip.md", content: "# Skip\n" });

        const manifest = yield* store.manifest({ folderRelPath: "bulk" });
        assert.lengthOf(manifest, 12);
        assert.equal(manifest[0]?.relPath, "bulk/note-00.md");
        assert.notProperty(manifest[0], "absPath");
        assert.notProperty(manifest[0], "abs_path");

        const limited = yield* store.manifest({ folderRelPath: "bulk", limit: 5 });
        assert.lengthOf(limited, 5);

        const all = yield* store.manifest({});
        assert.lengthOf(all, 13);
        const invalidLimit = yield* Effect.flip(store.manifest({ limit: 0 }));
        assert.equal(invalidLimit.code, "invalid_limit");
      }),
    ),
  );

  it.effect("rejects path traversal and absolute paths without touching anything outside", () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const document = yield* store.createDoc({ relPath: "notes/plan.md", content: "# Plan\n" });

        const documentError = yield* Effect.flip(store.createDoc({ relPath: "../escape.md" }));
        assert.equal(documentError.code, "invalid_path");
        const driveError = yield* Effect.flip(store.createDoc({ relPath: "C:\\escape.md" }));
        assert.equal(driveError.code, "invalid_path");
        const folderError = yield* Effect.flip(
          store.createFolder({ relPath: "notes/../../escape" }),
        );
        assert.equal(folderError.code, "invalid_path");
        const moveError = yield* Effect.flip(
          store.moveDoc({ relPath: document.relPath, newParentRelPath: "../outside" }),
        );
        assert.equal(moveError.code, "invalid_path");
        const readError = yield* Effect.flip(store.getByPath("notes/../../../escape.md"));
        assert.equal(readError.code, "invalid_path");

        assert.isFalse(yield* fileExists(NodePath.join(root, "escape.md")));
        assert.isFalse(yield* fileExists(NodePath.resolve(root, "..", "escape.md")));
        assert.isTrue(yield* fileExists(contextPath(root, "notes/plan.md")));
      }),
    ),
  );
});
