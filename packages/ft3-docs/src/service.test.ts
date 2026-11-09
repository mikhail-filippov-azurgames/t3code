// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off globalErrorInEffectCatch:off - the tests create a document store on disk with fresh ids; symlink EPERM skip needs the raw errno.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import type { DocsChanged } from "./reconciler.ts";
import * as Service from "./service.ts";
import * as WriteRule from "./writeRule.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

// The repository never carries real document ids; tests use nil-style ids.
const NIL_ID = "00000000-0000-0000-0000-000000000000";

const cryptoLayer = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => globalThis.crypto.getRandomValues(new Uint8Array(size))),
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
  /**
   * Protection port override; nothing is protected by default. `true`
   * protects every document, a predicate protects only what it names, and
   * `"fail"` fails every check, proving writes refuse when the identities
   * cannot be established.
   */
  readonly isProtected?:
    | boolean
    | "fail"
    | ((document: { readonly stableId: string; readonly relPath: string }) => boolean);
  /** Write rule override; the default ports refuse every write. */
  readonly writeAccess?: Layer.Layer<Service.DocumentsWriteAccess>;
  /** Change bus service-side writes publish to; nothing is emitted without it. */
  readonly events?: Layer.Layer<Service.DocsChangeBus>;
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
    const isProtectedOption = options.isProtected;
    const protection =
      isProtectedOption === undefined
        ? Service.noProtectedDocuments
        : isProtectedOption === "fail"
          ? Layer.succeed(
              Service.DocsProtection,
              Service.DocsProtection.of({
                isProtected: () =>
                  Effect.fail(new Service.DocsServiceError({ code: "store_unavailable" })),
              }),
            )
          : Layer.succeed(
              Service.DocsProtection,
              Service.DocsProtection.of({
                isProtected: (document) =>
                  Effect.succeed(
                    typeof isProtectedOption === "function"
                      ? isProtectedOption(document)
                      : isProtectedOption,
                  ),
              }),
            );
    const services = (
      options.writeAccess !== undefined
        ? Service.layer({ root }).pipe(Layer.provide(options.writeAccess))
        : options.writable === true
          ? Service.layer({ root }).pipe(Layer.provide(allowStoreWrite))
          : Service.layerWithDefaultPorts({ root })
    ).pipe(Layer.provide(protection), Layer.provide(sqlLayer()), Layer.provide(cryptoLayer));
    return yield* Effect.gen(function* () {
      if (setup !== undefined) yield* Effect.orDie(setup(root));
      const context = { root, service: yield* Service.DocsService } satisfies DocsTest;
      return yield* use(context);
    }).pipe(
      Effect.provide(services.pipe(Layer.provide(options.events ?? Service.noChangeEvents))),
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

/**
 * Symlink creation needs privileges on Windows; a test that plants links
 * skips there when the platform refuses, and fails anywhere else.
 */
const trySymlink = (target: string, path: string, type: "file" | "dir") =>
  Effect.tryPromise({
    try: () => NodeFSP.symlink(target, path, type),
    catch: (cause) => cause as NodeJS.ErrnoException,
  }).pipe(
    Effect.as(true),
    // Without link privileges the OS refuses with EPERM; the test cannot run
    // there, so it skips instead of failing.
    Effect.catchIf(
      (cause) => cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EPERM",
      () => Effect.succeed(false),
    ),
  );

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

  it.effect(
    "reads a store-path file the store registered no document for, like a json manifest",
    () =>
      withDocs(
        (context) =>
          Effect.gen(function* () {
            yield* prime(context.service);
            const read = yield* context.service.read({ ref: "policies/roles.json" });
            assert.include(read.content, "corvis-role-map-v1");
            assert.equal(read.stableId, "");
            assert.equal(read.ocLink, "");
            assert.equal(read.relPath, "policies/roles.json");

            const missing = yield* context.service
              .read({ ref: "policies/absent.json" })
              .pipe(Effect.flip);
            assert.equal(missing.code, "document_not_found");
          }),
        (root) =>
          Effect.gen(function* () {
            yield* writeDoc(root, "project/plan.md", `---\nstable_id: ${NIL_ID}\n---\n# Plan\n`);
            yield* writeDoc(
              root,
              "policies/roles.json",
              '{ "schema": "corvis-role-map-v1", "revision": 1 }\n',
            );
          }),
      ),
  );

  it.effect("refuses store paths that escape the docs root through the fallback", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          // A drive-qualified segment parses as a store path but must not touch disk.
          const drive = yield* context.service
            .read({ ref: "safe/D:/secret.json" })
            .pipe(Effect.flip);
          assert.equal(drive.code, "document_not_found");
          // `..` never parses as a store path at all.
          const dotDot = yield* context.service
            .read({ ref: "policies/../outside.json" })
            .pipe(Effect.flip);
          assert.equal(dotDot.code, "document_outside_store");
          // A junction/symlink to a directory outside the root resolves outside.
          const link = yield* context.service
            .read({ ref: "linkedDir/secret.json" })
            .pipe(Effect.flip);
          assert.equal(link.code, "document_not_found");

          const tampered = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(context.root, "outside-dir", "secret.json"), "utf8"),
          );
          assert.equal(tampered, "secret");
        }),
      (root) =>
        Effect.gen(function* () {
          yield* writeDoc(root, "project/plan.md", `---\nstable_id: ${NIL_ID}\n---\n# Plan\n`);
          const outsideDir = NodePath.join(root, "outside-dir");
          yield* Effect.promise(() =>
            NodeFSP.mkdir(outsideDir, { recursive: true }).then(() =>
              NodeFSP.writeFile(NodePath.join(outsideDir, "secret.json"), "secret", "utf8"),
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.symlink(outsideDir, NodePath.join(root, "contexts", "linkedDir"), "dir"),
          );
        }),
    ),
  );

  it.effect(
    "refuses a registered document whose file or parent dir became a link outside the root",
    () =>
      withDocs(
        (context) =>
          Effect.gen(function* () {
            yield* prime(context.service);
            const outside = NodePath.join(context.root, "outside");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(outside, { recursive: true }).then(() =>
                NodeFSP.writeFile(NodePath.join(outside, "secret.md"), "secret\n", "utf8"),
              ),
            );

            // The registered file swapped for a link to the outside copy.
            const filePath = NodePath.join(context.root, "contexts", "project", "plan.md");
            yield* Effect.promise(() => NodeFSP.rm(filePath, { force: true }));
            if (!(yield* trySymlink(NodePath.join(outside, "secret.md"), filePath, "file"))) return;
            const fileLink = yield* context.service
              .read({ ref: `oc://doc/${NIL_ID}` })
              .pipe(Effect.flip);
            assert.equal(fileLink.code, "document_outside_store");

            // The whole parent dir swapped for a link to an outside copy.
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.join(context.root, "contexts", "project"), {
                recursive: true,
                force: true,
              }),
            );
            const outsideTree = NodePath.join(outside, "tree");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(outsideTree, { recursive: true }).then(() =>
                NodeFSP.writeFile(NodePath.join(outsideTree, "plan.md"), "secret\n", "utf8"),
              ),
            );
            if (
              !(yield* trySymlink(
                outsideTree,
                NodePath.join(context.root, "contexts", "project"),
                "dir",
              ))
            )
              return;
            const dirLink = yield* context.service
              .read({ ref: `oc://doc/${NIL_ID}` })
              .pipe(Effect.flip);
            assert.equal(dirLink.code, "document_outside_store");
          }),
        (root) => seedFiles(root),
      ),
  );

  it.effect("reports the filesystem stat of a document without reading it", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const stamped = yield* context.service.docStat(`oc://doc/${NIL_ID}`);
          assert.isNotNull(stamped);
          yield* context.service.writeAsHuman({
            ref: `oc://doc/${NIL_ID}`,
            content: "# Plan\n\nStorage again, with more bytes than before.\n",
          });
          const after = yield* context.service.docStat(`oc://doc/${NIL_ID}`);
          assert.isNotNull(after);
          assert.isTrue(
            after !== null &&
              stamped !== null &&
              (after.mtimeMs !== stamped.mtimeMs || after.size !== stamped.size),
          );
          assert.isNull(yield* context.service.docStat(`oc://doc/${crypto.randomUUID()}`));
          vi.mocked(NodeFS.statSync).mockImplementationOnce(() => {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          });
          assert.isNull(yield* context.service.docStat(`oc://doc/${NIL_ID}`));
        }),
      (root) => seedFiles(root),
    ),
  );

  it.effect("never writes through the fallback to a path outside the docs root", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          for (const ref of ["safe/D:/secret.json", "linkedDir/secret.json"]) {
            const error = yield* context.service
              .writeAsHuman({ ref, content: "overwritten", baseSha256: "a".repeat(64) })
              .pipe(Effect.flip);
            assert.equal(error.code, "document_not_found");
          }
          const tampered = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(context.root, "outside-dir", "secret.json"), "utf8"),
          );
          assert.equal(tampered, "secret");
        }),
      (root) =>
        Effect.gen(function* () {
          yield* writeDoc(root, "project/plan.md", `---\nstable_id: ${NIL_ID}\n---\n# Plan\n`);
          const outsideDir = NodePath.join(root, "outside-dir");
          yield* Effect.promise(() =>
            NodeFSP.mkdir(outsideDir, { recursive: true }).then(() =>
              NodeFSP.writeFile(NodePath.join(outsideDir, "secret.json"), "secret", "utf8"),
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.symlink(outsideDir, NodePath.join(root, "contexts", "linkedDir"), "dir"),
          );
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

  it.effect("lets the human save a store-path file that has no registered document", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const live = yield* context.service.read({ ref: "policies/roles.json" });
          const saved = yield* context.service.writeAsHuman({
            ref: "policies/roles.json",
            content: '{ "schema": "corvis-role-map-v1", "revision": 2 }\n',
            baseSha256: live.sha256,
          });
          assert.notEqual(saved.sha256, live.sha256);
          const reread = yield* context.service.read({ ref: "policies/roles.json" });
          assert.include(reread.content, '"revision": 2');

          const stale = yield* context.service
            .writeAsHuman({
              ref: "policies/roles.json",
              content: "# Stale\n",
              baseSha256: live.sha256,
            })
            .pipe(Effect.flip);
          assert.equal(stale.code, "document_changed");
        }),
      (root) =>
        Effect.gen(function* () {
          yield* writeDoc(root, "project/plan.md", `---\nstable_id: ${NIL_ID}\n---\n# Plan\n`);
          yield* writeDoc(
            root,
            "policies/roles.json",
            '{ "schema": "corvis-role-map-v1", "revision": 1 }\n',
          );
        }),
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

          const described = yield* context.service
            .setDescription({
              caller: { threadId: "thread:root", parentThreadId: null },
              ref: "project/plan.md",
              description: "Protected.",
            })
            .pipe(Effect.flip);
          assert.equal(described.code, "document_protected");
        }),
      seedFiles,
      { writable: true, isProtected: true },
    ),
  );

  it.effect("refuses a protected document to a granted general child", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const error = yield* context.service
            .write({
              caller: { threadId: "thread:general", parentThreadId: "thread:root" },
              ref: "project/plan.md",
              content: "# Rewritten\n",
              clientRequestId: "write:protected",
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "document_protected");
        }),
      seedFiles,
      {
        writeAccess: lineageWithFacts({ role: "general", planStableId: null, granted: true }),
        isProtected: true,
      },
    ),
  );

  it.effect("refuses a create inside a protected prefix to a granted general child", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          for (const relPath of [
            "policies/roles/new.md",
            "./policies/roles/new.md",
            ".\\policies\\roles\\new.md",
          ]) {
            const error = yield* context.service
              .write({
                caller: { threadId: "thread:general", parentThreadId: "thread:root" },
                relPath,
                content: "# New\n",
                clientRequestId: `write:create-protected:${relPath}`,
              })
              .pipe(Effect.flip);
            assert.equal(error.code, "document_protected");
          }

          const created = yield* context.service.write({
            caller: { threadId: "thread:general", parentThreadId: "thread:root" },
            relPath: "project/new.md",
            content: "# New\n",
            clientRequestId: "write:create-unprotected",
          });
          assert.equal(created.relPath, "project/new.md");
        }),
      seedFiles,
      {
        writeAccess: lineageWithFacts({ role: "general", planStableId: null, granted: true }),
        isProtected: (document) => document.relPath.startsWith("policies/"),
      },
    ),
  );

  it.effect("refuses the write when the protection check itself fails", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const error = yield* context.service
            .write({
              caller: { threadId: "thread:root", parentThreadId: null },
              ref: "project/plan.md",
              content: "# Rewritten\n",
              clientRequestId: "write:protection-down",
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "store_unavailable");
        }),
      seedFiles,
      { writable: true, isProtected: "fail" },
    ),
  );

  it.effect("lets a planner write its own plan past the protection port", () =>
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
        }),
      seedFiles,
      {
        writeAccess: lineageWithFacts({ role: "planner", planStableId: NIL_ID, granted: false }),
        isProtected: true,
      },
    ),
  );

  it.effect("lets the human save a protected document", () =>
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
          assert.equal(saved.stableId, NIL_ID);
        }),
      seedFiles,
      { isProtected: true },
    ),
  );

  it.effect("publishes added and changed events for service-side writes", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<DocsChanged>>([]);
      const events = Layer.succeed(
        Service.DocsChangeBus,
        Service.DocsChangeBus.of({
          publish: (change) => Ref.update(seen, (all) => [...all, change]),
          changes: Stream.empty,
        }),
      );
      return yield* withDocs(
        (context) =>
          Effect.gen(function* () {
            const caller = { threadId: "thread:root", parentThreadId: null };
            const created = yield* context.service.write({
              caller,
              relPath: "project/first.md",
              content: "# First\n",
              clientRequestId: "write:first",
            });
            const live = yield* context.service.read({ ref: `oc://doc/${created.stableId}` });
            yield* context.service.write({
              caller,
              ref: `oc://doc/${created.stableId}`,
              content: "# First\n\nMore.\n",
              baseSha256: live.sha256,
              clientRequestId: "write:second",
            });
            yield* context.service.setDescription({
              caller,
              ref: `oc://doc/${created.stableId}`,
              description: "First doc.",
            });
            const edited = yield* context.service.read({ ref: `oc://doc/${created.stableId}` });
            yield* context.service.writeAsHuman({
              ref: `oc://doc/${created.stableId}`,
              content: "# First\n\nHuman.\n",
              baseSha256: edited.sha256,
            });
            assert.deepStrictEqual(yield* Ref.get(seen), [
              { kind: "added", stableId: created.stableId, relPath: "project/first.md" },
              { kind: "changed", stableId: created.stableId, relPath: "project/first.md" },
              { kind: "changed", stableId: created.stableId, relPath: "project/first.md" },
              { kind: "changed", stableId: created.stableId, relPath: "project/first.md" },
            ]);
          }),
        seedFiles,
        { writable: true, events },
      );
    }),
  );

  it.effect("serializes concurrent writes with the same base sha", () =>
    withDocs(
      (context) =>
        Effect.gen(function* () {
          yield* prime(context.service);
          const live = yield* context.service.read({ ref: "project/plan.md" });
          const caller = { threadId: "thread:root", parentThreadId: null };
          const outcomes = yield* Effect.forEach(
            [
              context.service.write({
                caller,
                ref: "project/plan.md",
                content: "# Plan\n\nA.\n",
                baseSha256: live.sha256,
                clientRequestId: "write:a",
              }),
              context.service.write({
                caller,
                ref: "project/plan.md",
                content: "# Plan\n\nB.\n",
                baseSha256: live.sha256,
                clientRequestId: "write:b",
              }),
            ],
            (write) => Effect.result(write),
            { concurrency: 2 },
          );
          assert.equal(outcomes.filter((outcome) => Result.isSuccess(outcome)).length, 1);
          const [conflict = yield* Effect.die(new Error("expected one conflict"))] =
            outcomes.flatMap((outcome) => (Result.isFailure(outcome) ? [outcome.failure] : []));
          assert.equal(conflict.code, "document_changed");
        }),
      seedFiles,
      { writable: true },
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
