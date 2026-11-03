// @effect-diagnostics nodeBuiltinImport:off - the tests create a document store on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Service from "./service.ts";
import * as WriteRule from "./writeRule.ts";

// The repository never carries real document ids; tests use nil-style ids.
const NIL_ID = "00000000-0000-0000-0000-000000000000";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const sqlLayer = () => NodeSqliteClient.layer({ filename: ":memory:" });

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-service-")));

const removeRoot = (root: string) =>
  Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));

const writeDoc = (root: string, relPath: string, content: string) =>
  Effect.promise(async () => {
    const absolute = NodePath.join(root, "contexts", ...relPath.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, content, "utf8");
  });

const moveDoc = (root: string, from: string, to: string) =>
  Effect.promise(async () => {
    const absoluteFrom = NodePath.join(root, "contexts", ...from.split("/"));
    const absoluteTo = NodePath.join(root, "contexts", ...to.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(absoluteTo), { recursive: true });
    await NodeFSP.rename(absoluteFrom, absoluteTo);
  });

const allowStoreWrite = Layer.succeed(
  Service.DocumentsWriteAccess,
  Service.DocumentsWriteAccess.of({
    decide: () =>
      Effect.succeed({ _tag: "Allow", scope: "store", reason: "top_level_thread" } as const),
  }),
);

const lineageWithFacts = (value: WriteRule.DocumentsWriteFacts) =>
  WriteRule.documentsWriteAccessLayer.pipe(
    Layer.provide(
      Layer.succeed(
        WriteRule.DocumentsWriteFactsPort,
        WriteRule.DocumentsWriteFactsPort.of({ factsOf: () => Effect.succeed(value) }),
      ),
    ),
  );

interface DocsTest {
  readonly service: Service.DocsService["Service"];
  readonly root: string;
}

interface WithDocsOptions {
  readonly writable?: boolean;
  /** Protection port override; nothing is protected by default. */
  readonly isProtected?: boolean;
  /** Write rule override; the default ports refuse every write. */
  readonly writeAccess?: Layer.Layer<Service.DocumentsWriteAccess>;
}

/**
 * The service under test over a fresh store root. Files are written by the test
 * directly, and the first `oc://` read runs the reconcile pass that registers
 * them, the same way a restart does.
 */
const withDocs = <A, E>(
  use: (context: DocsTest) => Effect.Effect<A, E>,
  setup?: (root: string) => Effect.Effect<void>,
  options: WithDocsOptions = {},
) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    const protection =
      options.isProtected === true
        ? Layer.succeed(
            Service.DocsProtection,
            Service.DocsProtection.of({ isProtected: () => Effect.succeed(true) }),
          )
        : Service.noProtectedDocuments;
    return yield* Effect.gen(function* () {
      if (setup !== undefined) yield* Effect.orDie(setup(root));
      const context = { root, service: yield* Service.DocsService } satisfies DocsTest;
      return yield* use(context);
    }).pipe(
      Effect.provide(
        (options.writeAccess !== undefined
          ? Service.layer({ root }).pipe(Layer.provide(options.writeAccess))
          : options.writable === true
            ? Service.layer({ root }).pipe(Layer.provide(allowStoreWrite))
            : Service.layerWithDefaultPorts({ root })
        ).pipe(Layer.provide(protection), Layer.provide(sqlLayer()), Layer.provide(cryptoLayer)),
      ),
      Effect.ensuring(removeRoot(root)),
    );
  });

const seedFiles = (root: string) =>
  Effect.gen(function* () {
    yield* writeDoc(
      root,
      "project/plan.md",
      `---\nstable_id: ${NIL_ID}\n---\n# Plan\n\nStorage.\n`,
    );
    yield* writeDoc(root, "project/notes.md", "# Notes\n\nNo frontmatter id yet.\n");
  });

/** Registers the seeded files by running the reconciler through one id miss. */
const prime = (service: Service.DocsService["Service"]) =>
  service.read({ ref: `oc://doc/${NIL_ID}` });

describe("DocsService reads", () => {
  it.effect("lists one folder level with metadata and no absolute path", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const listed = yield* context.service.list({ folder: "project" });
          assert.equal(listed.folder, "project");
          assert.deepStrictEqual(
            listed.documents.map((entry) => entry.relPath),
            ["project/notes.md", "project/plan.md"],
          );
          assert.equal(listed.documents[1]?.stableId, NIL_ID);
          assert.notInclude(JSON.stringify(listed), "contexts");
          assert.notInclude(JSON.stringify(listed), context.root);
        }),
      seedFiles,
    ),
  );

  it.effect("manifests every document without a limit", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const manifest = yield* context.service.manifest({});
          assert.deepStrictEqual(
            manifest.map((entry) => entry.relPath),
            ["project/notes.md", "project/plan.md"],
          );
          assert.notInclude(JSON.stringify(manifest), context.root);
        }),
      seedFiles,
    ),
  );

  it.effect("reads by store path and by oc:// id", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const byPath = yield* context.service.read({ ref: "project/plan.md" });
          assert.equal(byPath.stableId, NIL_ID);
          assert.include(byPath.content, "# Plan");
          assert.equal(byPath.ocLink, `oc://doc/${NIL_ID}`);
          assert.equal(byPath.sha256.length, 64);

          const byId = yield* context.service.read({ ref: `oc://doc/${NIL_ID}@3` });
          assert.equal(byId.relPath, "project/plan.md");
          assert.equal(byId.content, byPath.content);

          const resolved = yield* context.service.resolve({ ref: `oc://doc/${NIL_ID}` });
          assert.equal(resolved.document.name, "plan.md");
          assert.equal(
            resolved.absolutePath,
            NodePath.join(context.root, "contexts", "project", "plan.md"),
          );
        }),
      seedFiles,
    ),
  );

  it.effect("finds a moved document by id after one reconcile pass", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          yield* moveDoc(context.root, "project/plan.md", "archive/plan.md");
          const byId = yield* context.service.read({ ref: `oc://doc/${NIL_ID}` });
          assert.equal(byId.relPath, "archive/plan.md");
        }),
      seedFiles,
    ),
  );

  it.effect("refuses a reference outside the store", () =>
    withDocs((context) =>
      Effect.gen(function* () {
        const error = yield* context.service
          .read({ ref: "C:/elsewhere/plan.md" })
          .pipe(Effect.flip);
        assert.equal(error.code, "document_outside_store");
      }),
    ),
  );
});

describe("DocsService writes", () => {
  it.effect("denies every write while no write rule is provided", () =>
    withDocs((context) =>
      Effect.gen(function* () {
        const error = yield* context.service
          .write({
            caller: { threadId: "thread:root", parentThreadId: null },
            relPath: "project/new.md",
            content: "# New\n",
            clientRequestId: "write:1",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
        assert.include(error.message, "write_disabled");
      }),
    ),
  );

  it.effect("lets a top-level thread write and names the reason for a child", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          const child = { threadId: "thread:child", parentThreadId: "thread:root" };
          const denied = yield* context.service
            .write({
              caller: child,
              relPath: "project/child.md",
              content: "# Child\n",
              clientRequestId: "write:child",
            })
            .pipe(Effect.flip);
          assert.equal(denied.code, "capability_denied");
          assert.include(denied.message, "child_read_only");

          const created = yield* context.service.write({
            caller: { threadId: "thread:root", parentThreadId: null },
            relPath: "project/top.md",
            content: "# Top\n",
            clientRequestId: "write:top",
          });
          assert.equal(created.relPath, "project/top.md");
        }),
      undefined,
      { writeAccess: WriteRule.lineageDocumentsWrite },
    ),
  );

  it.effect("lets a planner write only the plan document of its card", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const planner = { threadId: "thread:planner", parentThreadId: "thread:root" };
          const plan = yield* context.service.read({ ref: `oc://doc/${NIL_ID}` });

          const saved = yield* context.service.write({
            caller: planner,
            ref: plan.ocLink,
            content: `---\nstable_id: ${NIL_ID}\n---\n# Plan\n\nOwned.\n`,
            baseSha256: plan.sha256,
            clientRequestId: "write:plan",
          });
          assert.equal(saved.stableId, NIL_ID);

          const other = yield* context.service
            .write({
              caller: planner,
              ref: "project/notes.md",
              content: "# Notes\n\nChanged.\n",
              clientRequestId: "write:other",
            })
            .pipe(Effect.flip);
          assert.equal(other.code, "capability_denied");
          assert.include(other.message, "planner_other_document");

          const created = yield* context.service
            .write({
              caller: planner,
              relPath: "project/planner-new.md",
              content: "# New\n",
              clientRequestId: "write:planner-new",
            })
            .pipe(Effect.flip);
          assert.equal(created.code, "capability_denied");
          assert.include(created.message, "planner_other_document");

          const described = yield* context.service
            .setDescription({
              caller: planner,
              ref: "project/notes.md",
              description: "Not mine.",
            })
            .pipe(Effect.flip);
          assert.equal(described.code, "capability_denied");
          assert.include(described.message, "planner_other_document");
        }),
      seedFiles,
      {
        writeAccess: lineageWithFacts({
          role: "planner",
          planStableId: NIL_ID,
          granted: false,
        }),
      },
    ),
  );

  it.effect("creates, replaces with a matching sha, and refuses a stale one", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          const caller = { threadId: "thread:root", parentThreadId: null };
          const created = yield* context.service.write({
            caller,
            relPath: "project/created.md",
            content: "# Created\n",
            description: "A new document.",
            clientRequestId: "write:1",
          });
          assert.equal(created.relPath, "project/created.md");
          assert.equal(created.ocLink, `oc://doc/${created.stableId}`);

          const replaced = yield* context.service.write({
            caller,
            ref: created.ocLink,
            content: "# Created\n\nmore\n",
            baseSha256: created.sha256,
            clientRequestId: "write:2",
          });
          assert.notEqual(replaced.sha256, created.sha256);

          const stale = yield* context.service
            .write({
              caller,
              ref: created.ocLink,
              content: "# Changed again\n",
              baseSha256: created.sha256,
              clientRequestId: "write:3",
            })
            .pipe(Effect.flip);
          assert.equal(stale.code, "document_changed");
        }),
      undefined,
      { writable: true },
    ),
  );

  it.effect("lets the human save a policy document and refuses a stale base sha", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const live = yield* context.service.read({ ref: "project/plan.md" });
          const saved = yield* context.service.writeAsHuman({
            ref: "project/plan.md",
            content: `---\nstable_id: ${NIL_ID}\n---\n# Plan\n\nHuman edit.\n`,
            baseSha256: live.sha256,
          });
          assert.notEqual(saved.sha256, live.sha256);
          assert.include(
            (yield* context.service.read({ ref: "project/plan.md" })).content,
            "Human edit.",
          );

          const stale = yield* context.service
            .writeAsHuman({
              ref: "project/plan.md",
              content: "# Stale\n",
              baseSha256: live.sha256,
            })
            .pipe(Effect.flip);
          assert.equal(stale.code, "document_changed");
        }),
      seedFiles,
    ),
  );

  it.effect("maps an absolute server path to its store row, and rejects one outside", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const inside = yield* context.service.locateServerPath(
            NodePath.join(context.root, "contexts", "project", "plan.md"),
          );
          assert.deepStrictEqual(inside, { relPath: "project/plan.md", stableId: NIL_ID });
          const outside = yield* context.service.locateServerPath(
            NodePath.join(context.root, "elsewhere", "plan.md"),
          );
          assert.isNull(outside);
        }),
      seedFiles,
    ),
  );

  it.effect("protects a document the protection port names", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const error = yield* context.service
            .write({
              caller: { threadId: "thread:root", parentThreadId: null },
              ref: "project/plan.md",
              content: "# Rewritten\n",
              clientRequestId: "write:protected",
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "document_protected");
        }),
      seedFiles,
      { writable: true, isProtected: true },
    ),
  );
});

describe("DocsService search", () => {
  it.effect("indexes a written document and finds it by prefix", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* context.service.write({
            caller: { threadId: "thread:root", parentThreadId: null },
            relPath: "project/storage.md",
            content: "# Storage\n\nstorage decisions\n",
            clientRequestId: "write:search",
          });
          const results = yield* context.service.search({ query: "storag*" });
          assert.deepStrictEqual(
            results.map((result) => [result.relPath, result.title]),
            [["project/storage.md", "Storage"]],
          );
        }),
      undefined,
      { writable: true },
    ),
  );
});
