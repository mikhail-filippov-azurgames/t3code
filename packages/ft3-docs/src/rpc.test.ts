// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off globalErrorInEffectCatch:off - the tests create a document store on disk with fresh ids; symlink EPERM skip needs the raw errno.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FT3_DOCS_WS_METHODS, docsRpcHandlers } from "./rpc.ts";
import * as Service from "./service.ts";

// The repository never carries real document ids; tests use nil-style ids.
const NIL_ID = "00000000-0000-0000-0000-000000000000";

const cryptoLayer = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => globalThis.crypto.getRandomValues(new Uint8Array(size))),
);

const sqlLayer = () => NodeSqliteClient.layer({ filename: ":memory:" });

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-rpc-")));

const removeRoot = (root: string) =>
  Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));

const writeDoc = (root: string, relPath: string, content: string) =>
  Effect.promise(async () => {
    const absolute = NodePath.join(root, "contexts", ...relPath.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, content, "utf8");
  });

const withReadDocs = <A, E>(
  use: (root: string) => Effect.Effect<A, E, Service.DocsService>,
  setup?: (root: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    const services = Service.layerWithDefaultPorts({ root }).pipe(
      Layer.provide(Service.noProtectedDocuments),
      Layer.provide(sqlLayer()),
      Layer.provide(cryptoLayer),
      Layer.provide(Service.noChangeEvents),
    );
    return yield* Effect.gen(function* () {
      if (setup !== undefined) yield* Effect.orDie(setup(root));
      return yield* use(root);
    }).pipe(Effect.provide(services), Effect.ensuring(removeRoot(root)));
  });

const seedPlan = (root: string) =>
  writeDoc(root, "project/plan.md", `---\nstable_id: ${NIL_ID}\n---\n# Plan\n\nStorage.\n`);

describe("docs.read", () => {
  it.effect("reads document text through the thin handler", () =>
    withReadDocs(
      () =>
        Effect.gen(function* () {
          const service = yield* Service.DocsService;
          // The first read runs the reconcile pass that registers the seeded file.
          yield* service.read({ ref: `oc://doc/${NIL_ID}` });
          const result = yield* docsRpcHandlers[FT3_DOCS_WS_METHODS.docsRead]({
            ref: `oc://doc/${NIL_ID}`,
          });
          assert.equal(result.status, "found");
          if (result.status !== "found") return;
          assert.equal(result.stableId, NIL_ID);
          assert.equal(result.relPath, "project/plan.md");
          assert.equal(result.name, "plan.md");
          assert.match(result.sha256, /^[0-9a-f]{64}$/);
          assert.include(result.content, "# Plan");
          assert.notInclude(JSON.stringify(result), "contexts");
        }),
      seedPlan,
    ),
  );

  it.effect("refuses a registered document swapped for a link outside the root", () =>
    withReadDocs(
      (root) =>
        Effect.gen(function* () {
          const service = yield* Service.DocsService;
          // The first read runs the reconcile pass that registers the seeded file.
          yield* service.read({ ref: `oc://doc/${NIL_ID}` });
          const outside = NodePath.join(root, "outside");
          yield* Effect.promise(() =>
            NodeFSP.mkdir(outside, { recursive: true }).then(() =>
              NodeFSP.writeFile(NodePath.join(outside, "secret.md"), "secret\n", "utf8"),
            ),
          );
          const filePath = NodePath.join(root, "contexts", "project", "plan.md");
          yield* Effect.promise(() => NodeFSP.rm(filePath, { force: true }));
          const linked = yield* Effect.tryPromise({
            try: () => NodeFSP.symlink(NodePath.join(outside, "secret.md"), filePath, "file"),
            catch: (cause) => cause as NodeJS.ErrnoException,
          }).pipe(
            Effect.as(true),
            // Without link privileges the OS refuses with EPERM; the test
            // cannot run there, so it skips instead of failing.
            Effect.catchIf(
              (cause) =>
                cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EPERM",
              () => Effect.succeed(false),
            ),
          );
          if (!linked) return;
          const refused = yield* docsRpcHandlers[FT3_DOCS_WS_METHODS.docsRead]({
            ref: `oc://doc/${NIL_ID}`,
          });
          assert.deepStrictEqual(refused, { status: "unavailable" });
        }),
      seedPlan,
    ),
  );

  it.effect("reads a plan by its store path and reports a missing document", () =>
    withReadDocs(
      () =>
        Effect.gen(function* () {
          const service = yield* Service.DocsService;
          yield* service.read({ ref: `oc://doc/${NIL_ID}` });
          const byPath = yield* docsRpcHandlers[FT3_DOCS_WS_METHODS.docsRead]({
            ref: "project/plan.md",
          });
          assert.equal(byPath.status, "found");
          const missing = yield* docsRpcHandlers[FT3_DOCS_WS_METHODS.docsRead]({
            ref: `oc://doc/${crypto.randomUUID()}`,
          });
          assert.deepStrictEqual(missing, { status: "not_found" });
        }),
      seedPlan,
    ),
  );
});
