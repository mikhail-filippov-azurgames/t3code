// @effect-diagnostics nodeBuiltinImport:off - the test creates a document store on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { DocsChanged } from "./reconciler.ts";
import * as DocsReconciler from "./reconciler.ts";
import * as DocsStore from "./store.ts";
import * as DocsWatch from "./watch.ts";

const NIL_ID = "00000000-0000-0000-0000-000000000000";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-watch-")));

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

const eventFor = (root: string, relPath: string): DocsWatch.DocsWatchEvent => ({
  path: NodePath.join(root, "contexts", ...relPath.split("/")),
  failed: false,
});

interface WatchHarness {
  readonly layer: Layer.Layer<
    | DocsWatch.DocsWatchService
    | DocsReconciler.DocsReconciler
    | DocsStore.DocsStore
    | import("effect/sql/SqlClient").SqlClient,
    DocsStore.DocsStoreError | import("effect/sql/SqlError").SqlError,
    never
  >;
  readonly events: Queue.Queue<DocsWatch.DocsWatchEvent>;
  readonly consumed: Queue.Queue<number>;
  readonly reconcileCount: Ref.Ref<number>;
}

const makeHarness = Effect.fn("watchTest.makeHarness")(function* (
  root: string,
  withEvents: boolean,
) {
  const events = yield* Queue.unbounded<DocsWatch.DocsWatchEvent>();
  const consumed = yield* Queue.unbounded<number>();
  const reconcileCount = yield* Ref.make(0);
  let seen = 0;

  const realReconciler = DocsReconciler.layer({ root }).pipe(Layer.provide(cryptoLayer));
  const countingReconciler = Layer.effect(
    DocsReconciler.DocsReconciler,
    Effect.gen(function* () {
      const inner = yield* DocsReconciler.DocsReconciler;
      return DocsReconciler.DocsReconciler.of({
        reconcile: Effect.fn("watchTest.countingReconcile")(function* () {
          yield* Ref.update(reconcileCount, (count) => count + 1);
          return yield* inner.reconcile();
        }),
        isSelfWrite: (path) => inner.isSelfWrite(path),
      });
    }),
  ).pipe(Layer.provide(realReconciler));

  const eventStream = Stream.fromQueue(events).pipe(
    Stream.tap(() => {
      seen += 1;
      return Queue.offer(consumed, seen).pipe(Effect.asVoid);
    }),
  );

  const storeLayer = DocsStore.layer({ root }).pipe(Layer.provide(cryptoLayer));
  const layer = Layer.provideMerge(
    DocsWatch.layer({ root, ...(withEvents ? { events: eventStream } : {}) }),
    Layer.provideMerge(
      countingReconciler,
      Layer.mergeAll(storeLayer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );
  return { layer, events, consumed, reconcileCount } satisfies WatchHarness;
});

const collectOne = (watcher: DocsWatch.DocsWatchService["Service"]) =>
  Stream.runCollect(Stream.take(watcher.changes, 1)).pipe(Effect.map((chunk) => [...chunk]));

describe("DocsWatchService", () => {
  it.effect("debounces watch events into one reconcile and publishes changed docs", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot();
      const harness = yield* makeHarness(root, true);
      return yield* Effect.gen(function* () {
        yield* writeDoc(root, "watched.md", `---\nstable_id: ${NIL_ID}\n---\n# Watched\n`);
        const watcher = yield* DocsWatch.DocsWatchService;

        const received = yield* Deferred.make<Array<DocsChanged>>();
        yield* collectOne(watcher).pipe(
          Effect.flatMap((entries) => Deferred.succeed(received, entries)),
          Effect.forkChild,
        );

        Queue.offerUnsafe(harness.events, eventFor(root, "watched.md"));
        Queue.offerUnsafe(harness.events, eventFor(root, "watched.md"));
        assert.equal(yield* Queue.take(harness.consumed), 1);
        assert.equal(yield* Queue.take(harness.consumed), 2);
        yield* TestClock.adjust("250 millis");

        const entries = yield* Deferred.await(received);
        assert.deepEqual(
          entries.map((entry) => [entry.kind, entry.relPath]),
          [["added", "watched.md"]],
        );
        assert.equal(yield* Ref.get(harness.reconcileCount), 1);
      }).pipe(Effect.provide(harness.layer), Effect.ensuring(removeRoot(root)));
    }).pipe(Effect.scoped),
  );

  it.effect("ignores the watch echo of the reconciler's own frontmatter write", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot();
      const harness = yield* makeHarness(root, true);
      return yield* Effect.gen(function* () {
        // No frontmatter id: the first watch pass registers the file and writes one.
        yield* writeDoc(root, "self.md", "# Self\n\nno id yet\n");
        const watcher = yield* DocsWatch.DocsWatchService;

        const received = yield* Deferred.make<Array<DocsChanged>>();
        yield* collectOne(watcher).pipe(
          Effect.flatMap((entries) => Deferred.succeed(received, entries)),
          Effect.forkChild,
        );

        Queue.offerUnsafe(harness.events, eventFor(root, "self.md"));
        assert.equal(yield* Queue.take(harness.consumed), 1);
        yield* TestClock.adjust("250 millis");
        const first = yield* Deferred.await(received);
        assert.deepEqual(
          first.map((entry) => entry.kind),
          ["added"],
        );

        // The frontmatter write from that pass echoes back; it must be dropped.
        const before = yield* readDoc(root, "self.md");
        yield* writeDoc(root, "self.md", `${before}\nmore\n`);
        const receivedAgain = yield* Deferred.make<Array<DocsChanged>>();
        yield* collectOne(watcher).pipe(
          Effect.flatMap((entries) => Deferred.succeed(receivedAgain, entries)),
          Effect.forkChild,
        );
        Queue.offerUnsafe(harness.events, eventFor(root, "self.md"));
        assert.equal(yield* Queue.take(harness.consumed), 2);
        Queue.offerUnsafe(harness.events, eventFor(root, "self.md"));
        assert.equal(yield* Queue.take(harness.consumed), 3);
        yield* TestClock.adjust("250 millis");

        const second = yield* Deferred.await(receivedAgain);
        assert.deepEqual(
          second.map((entry) => entry.kind),
          ["changed"],
        );
        // Two watch passes plus zero from the dropped echo.
        assert.equal(yield* Ref.get(harness.reconcileCount), 2);
      }).pipe(Effect.provide(harness.layer), Effect.ensuring(removeRoot(root)));
    }).pipe(Effect.scoped),
  );

  it.effect("a failed watcher event still triggers a full reconcile", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot();
      const harness = yield* makeHarness(root, true);
      return yield* Effect.gen(function* () {
        yield* writeDoc(root, "probe.md", `---\nstable_id: ${NIL_ID}\n---\n# Probe\n`);
        const watcher = yield* DocsWatch.DocsWatchService;

        const received = yield* Deferred.make<Array<DocsChanged>>();
        yield* collectOne(watcher).pipe(
          Effect.flatMap((entries) => Deferred.succeed(received, entries)),
          Effect.forkChild,
        );

        Queue.offerUnsafe(harness.events, { path: root, failed: true });
        assert.equal(yield* Queue.take(harness.consumed), 1);
        yield* TestClock.adjust("250 millis");

        const entries = yield* Deferred.await(received);
        assert.deepEqual(
          entries.map((entry) => entry.kind),
          ["added"],
        );
      }).pipe(Effect.provide(harness.layer), Effect.ensuring(removeRoot(root)));
    }).pipe(Effect.scoped),
  );

  it.live("watches the real file system and reports external edits", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot();
      const harness = yield* makeHarness(root, false);
      return yield* Effect.gen(function* () {
        yield* writeDoc(root, "live.md", `---\nstable_id: ${NIL_ID}\n---\n# Live\n`);
        const watcher = yield* DocsWatch.DocsWatchService;
        const reconciler = yield* DocsReconciler.DocsReconciler;
        // Register before subscribing; the edit below must surface as "changed".
        yield* reconciler.reconcile();

        const received = yield* Deferred.make<Array<DocsChanged>>();
        yield* collectOne(watcher).pipe(
          Effect.flatMap((entries) => Deferred.succeed(received, entries)),
          Effect.forkChild,
        );

        // External editor save, observed through the real OS watcher.
        yield* writeDoc(root, "live.md", `---\nstable_id: ${NIL_ID}\n---\n# Live\n\nedited\n`);

        const entries = yield* Deferred.await(received);
        assert.deepEqual(
          entries.map((entry) => entry.kind),
          ["changed"],
        );
      }).pipe(Effect.provide(harness.layer), Effect.ensuring(removeRoot(root)));
    }).pipe(Effect.scoped),
  );
});
