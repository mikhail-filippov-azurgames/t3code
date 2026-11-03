// @effect-diagnostics nodeBuiltinImport:off - the test creates a document store on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Frontmatter from "./frontmatter.ts";
import * as DocsReconciler from "./reconciler.ts";
import * as DocsStore from "./store.ts";

// The repository never carries real document ids; tests use the nil UUID.
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const OTHER_ID = "00000000-0000-0000-0000-000000000001";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-reconcile-")));

const removeRoot = (root: string) =>
  Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));

const writeDoc = (root: string, relPath: string, content: string) =>
  Effect.promise(async () => {
    const absolute = NodePath.join(root, "contexts", ...relPath.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, content, "utf8");
  });

const readDoc = (root: string, relPath: string) =>
  Effect.promise(() =>
    NodeFSP.readFile(NodePath.join(root, "contexts", ...relPath.split("/")), "utf8"),
  );

const moveDoc = (root: string, from: string, to: string) =>
  Effect.promise(async () => {
    const source = NodePath.join(root, "contexts", ...from.split("/"));
    const target = NodePath.join(root, "contexts", ...to.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.rename(source, target);
  });

const removeDoc = (root: string, relPath: string) =>
  Effect.promise(() => NodeFSP.rm(NodePath.join(root, "contexts", ...relPath.split("/"))));

const docExists = (root: string, relPath: string) =>
  Effect.promise(() =>
    NodeFSP.access(NodePath.join(root, "contexts", ...relPath.split("/"))).then(
      () => true,
      () => false,
    ),
  );

interface ReconcileDeps {
  readonly reconciler: DocsReconciler.DocsReconciler["Service"];
  readonly store: DocsStore.DocsStore["Service"];
  readonly sql: SqlClient.SqlClient;
  readonly root: string;
}

const withReconciler = <A, E>(use: (deps: ReconcileDeps) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    const storeLayer = DocsStore.layer({ root }).pipe(Layer.provide(cryptoLayer));
    const layer = Layer.provideMerge(
      DocsReconciler.layer({ root }),
      Layer.mergeAll(storeLayer, NodeSqliteClient.layer({ filename: ":memory:" })),
    );
    return yield* Effect.gen(function* () {
      const deps: ReconcileDeps = {
        reconciler: yield* DocsReconciler.DocsReconciler,
        store: yield* DocsStore.DocsStore,
        sql: yield* SqlClient.SqlClient,
        root,
      };
      return yield* use(deps);
    }).pipe(Effect.provide(layer), Effect.ensuring(removeRoot(root)));
  });

describe("DocsReconciler", () => {
  it.effect("registers a new file, writes stable_id to frontmatter and indexes it", () =>
    withReconciler(({ reconciler, sql, root }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "notes/todo.md", "# Todo\n\nbuy milk\n");
        const report = yield* reconciler.reconcile();

        assert.equal(report.added.length, 1);
        const [registered = yield* Effect.die(new Error("expected one added doc"))] = report.added;
        assert.equal(registered.relPath, "notes/todo.md");
        assert.match(registered.stableId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(
          report.changed.map((entry) => entry.kind),
          ["added"],
        );
        assert.equal(report.toIndex.length, 1);
        const [indexable = yield* Effect.die(new Error("expected one indexable doc"))] =
          report.toIndex;
        assert.equal(indexable.title, "Todo");

        const content = yield* readDoc(root, "notes/todo.md");
        assert.equal(Frontmatter.readStableId(content), registered.stableId);
        // The self-write is recorded so the watch service ignores its own echo.
        assert.isTrue(reconciler.isSelfWrite(NodePath.join(root, "contexts", "notes", "todo.md")));
        assert.isFalse(reconciler.isSelfWrite(NodePath.join(root, "contexts", "notes", "todo.md")));

        const rows = yield* sql<{ readonly stableId: string; readonly relPath: string }>`
          SELECT stable_id AS "stableId", rel_path AS "relPath" FROM ft3_docs_file_state
        `;
        assert.deepEqual(rows, [{ stableId: registered.stableId, relPath: "notes/todo.md" }]);

        // A second pass over an unchanged tree is a no-op.
        const again = yield* reconciler.reconcile();
        assert.deepEqual(again.changed, []);
        assert.deepEqual(again.toIndex, []);
      }),
    ),
  );

  it.effect("keeps the frontmatter bytes of a file that already has an id", () =>
    withReconciler(({ reconciler, root }) =>
      Effect.gen(function* () {
        const before = `---\r\nstable_id: ${NIL_ID}\r\ntitle: Keep me\r\n---\r\nbody\r\n`;
        yield* writeDoc(root, "keep.md", before);
        const report = yield* reconciler.reconcile();
        const [keptNew = yield* Effect.die(new Error("expected one added doc"))] = report.added;
        assert.equal(keptNew.stableId, NIL_ID);
        assert.equal(yield* readDoc(root, "keep.md"), before);
      }),
    ),
  );

  it.effect("matches a moved file by frontmatter stable_id and updates the row", () =>
    withReconciler(({ reconciler, root, store }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "a/one.md", `---\nstable_id: ${NIL_ID}\n---\n# One\n`);
        const first = yield* reconciler.reconcile();
        const [registeredFirst = yield* Effect.die(new Error("expected one added doc"))] =
          first.added;
        const stableId = registeredFirst.stableId;

        yield* moveDoc(root, "a/one.md", "b/two.md");
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(root, "contexts", "a"), { recursive: true }),
        );
        const report = yield* reconciler.reconcile();

        assert.deepEqual(report.moved, [
          { stableId, fromRelPath: "a/one.md", toRelPath: "b/two.md" },
        ]);
        assert.deepEqual(
          report.changed.map((entry) => entry.kind),
          ["moved"],
        );
        const [movedIndex = yield* Effect.die(new Error("expected one indexable doc"))] =
          report.toIndex;
        assert.equal(movedIndex.relPath, "b/two.md");

        assert.isNull(yield* store.getByPath("a/one.md"));
        const moved = yield* store.getByPath("b/two.md");
        assert.equal(moved?.stableId, stableId);

        // The emptied directory row is gone; the new one exists.
        const folders = yield* store.listAllFolders();
        assert.deepEqual(
          folders.map((folder) => folder.relPath),
          ["", "b"],
        );
      }),
    ),
  );

  it.effect("registers a copied file under its own frontmatter id", () =>
    withReconciler(({ reconciler, root }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "origin.md", `---\nstable_id: ${NIL_ID}\n---\n# Origin\n`);
        yield* writeDoc(root, "copy.md", `---\nstable_id: ${OTHER_ID}\n---\n# Copy\n`);
        const report = yield* reconciler.reconcile();
        assert.deepEqual(report.added.map((record) => [record.relPath, record.stableId]).sort(), [
          ["copy.md", OTHER_ID],
          ["origin.md", NIL_ID],
        ]);
      }),
    ),
  );

  it.effect("splits duplicate stable ids and reports duplicate_stable_id", () =>
    withReconciler(({ reconciler, root, store }) =>
      Effect.gen(function* () {
        const body = `---\nstable_id: ${NIL_ID}\n---\n# Same\n`;
        yield* writeDoc(root, "first.md", body);
        yield* writeDoc(root, "second.md", body);
        const report = yield* reconciler.reconcile();

        assert.equal(report.duplicates.length, 1);
        const [duplicate = yield* Effect.die(new Error("expected one duplicate"))] =
          report.duplicates;
        assert.equal(duplicate.keptRelPath, "first.md");
        assert.equal(duplicate.duplicateRelPath, "second.md");
        assert.match(duplicate.newStableId, /^[0-9a-f-]{36}$/);
        assert.notEqual(duplicate.newStableId, NIL_ID);
        assert.match(report.warnings.join("\n"), /had the same id/);

        const kept = yield* store.getByPath("first.md");
        const split = yield* store.getByPath("second.md");
        assert.equal(kept?.stableId, NIL_ID);
        assert.equal(split?.stableId, duplicate.newStableId);
        assert.equal(Frontmatter.readStableId(yield* readDoc(root, "second.md")), split?.stableId);
        assert.equal(Frontmatter.readStableId(yield* readDoc(root, "first.md")), NIL_ID);
      }),
    ),
  );

  it.effect("adopts the row id when an external write left no frontmatter id", () =>
    withReconciler(({ reconciler, root, store }) =>
      Effect.gen(function* () {
        // Simulate an external `oc` document: a row without frontmatter id.
        const record = yield* store.registerExisting({ relPath: "oc-made.md", stableId: NIL_ID });
        yield* writeDoc(root, "oc-made.md", "# External\n\nno frontmatter here\n");

        const report = yield* reconciler.reconcile();
        assert.equal(Frontmatter.readStableId(yield* readDoc(root, "oc-made.md")), record.stableId);
        assert.deepEqual(
          report.changed.map((entry) => entry.kind),
          ["changed"],
        );
      }),
    ),
  );

  it.effect("reports a missing file, keeps the row for one pass and removes it after two", () =>
    withReconciler(({ reconciler, store, sql, root }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "dying.md", `---\nstable_id: ${NIL_ID}\n---\n# Dying\n`);
        yield* reconciler.reconcile();

        yield* removeDoc(root, "dying.md");
        const first = yield* reconciler.reconcile();
        assert.deepEqual(first.removed, []);
        assert.deepEqual(first.missing, [{ stableId: NIL_ID, relPath: "dying.md", passes: 1 }]);

        assert.isNotNull(yield* store.getByPath("dying.md"));

        const second = yield* reconciler.reconcile();
        assert.deepEqual(
          second.removed.map((entry) => entry.relPath),
          ["dying.md"],
        );
        assert.deepEqual(second.toRemove, [NIL_ID]);
        assert.isNull(yield* store.getByPath("dying.md"));
        const rows = yield* sql`SELECT stable_id FROM ft3_docs_file_state`;
        assert.deepEqual(rows, []);
      }),
    ),
  );

  it.effect("a returned file within the grace window keeps its stable id", () =>
    withReconciler(({ reconciler, root, store }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "back.md", `---\nstable_id: ${NIL_ID}\n---\n# Back\n`);
        yield* reconciler.reconcile();
        yield* removeDoc(root, "back.md");
        const first = yield* reconciler.reconcile();
        assert.equal(first.missing.length, 1);

        yield* writeDoc(root, "back.md", `---\nstable_id: ${NIL_ID}\n---\n# Back, edited\n`);
        const second = yield* reconciler.reconcile();
        assert.deepEqual(second.missing, []);
        assert.deepEqual(second.removed, []);
        assert.equal((yield* store.getByPath("back.md"))?.stableId, NIL_ID);
      }),
    ),
  );

  it.effect("reindexes when the content changes and follows the row on rename", () =>
    withReconciler(({ reconciler, root }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "edit.md", `---\nstable_id: ${NIL_ID}\n---\n# Edit\n\napple\n`);
        yield* reconciler.reconcile();

        yield* writeDoc(root, "edit.md", `---\nstable_id: ${NIL_ID}\n---\n# Edit\n\nbanana\n`);
        const report = yield* reconciler.reconcile();
        assert.deepEqual(
          report.changed.map((entry) => entry.kind),
          ["changed"],
        );
        const [editedIndex = yield* Effect.die(new Error("expected one indexable doc"))] =
          report.toIndex;
        assert.equal(editedIndex.body.includes("banana"), true);
      }),
    ),
  );

  it.effect("tracks folder rows for directories on disk and drops vanished ones", () =>
    withReconciler(({ reconciler, root, store }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "contexts", "empty"), { recursive: true });
        });
        yield* writeDoc(root, "sub/file.md", `---\nstable_id: ${NIL_ID}\n---\n# F\n`);
        const report = yield* reconciler.reconcile();
        assert.deepEqual(
          report.added.map((record) => record.relPath),
          ["sub/file.md"],
        );
        assert.deepEqual(
          (yield* store.listAllFolders()).map((folder) => folder.relPath),
          ["", "empty", "sub"],
        );

        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(root, "contexts", "empty"), { recursive: true }),
        );
        const next = yield* reconciler.reconcile();
        assert.deepEqual(next.changed, []);
        assert.deepEqual(
          (yield* store.listAllFolders()).map((folder) => folder.relPath),
          ["", "sub"],
        );
      }),
    ),
  );

  it.effect("never deletes user files", () =>
    withReconciler(({ reconciler, root }) =>
      Effect.gen(function* () {
        yield* writeDoc(root, "user.md", `---\nstable_id: ${NIL_ID}\n---\n# User\n`);
        yield* reconciler.reconcile();
        // Repeated passes must not touch the file on disk.
        yield* reconciler.reconcile();
        yield* reconciler.reconcile();
        assert.isTrue(yield* docExists(root, "user.md"));
      }),
    ),
  );
});
