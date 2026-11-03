// @effect-diagnostics nodeBuiltinImport:off - the index worker hashes the document bytes it reads.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DocsIndex from "./index.ts";
import * as DocsReconciler from "./reconciler.ts";
import * as DocsStore from "./store.ts";
import * as DocsWatch from "./watch.ts";

export interface DocsRuntimeOptions {
  /** Store root: `contexts/` and `opencontext.db` live directly under it. */
  readonly root: string;
}

const index = Layer.catch(() => DocsIndex.unavailableLayer)(DocsIndex.layer);

const sha256Hex = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

/** Titles follow the reconciler's rule: the first `# ` heading, else the file name. */
const titleOf = (content: string, relPath: string): string => {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line.replace(/\r$/, ""));
    if (match?.[1] !== undefined) return match[1];
  }
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
};

export const runtimeLayer = (options: DocsRuntimeOptions) => {
  const store = DocsStore.layer(options);
  const reconciler = DocsReconciler.layer(options).pipe(Layer.provide(store));
  const watcher = DocsWatch.layer({ root: options.root }).pipe(
    Layer.provide(reconciler),
    Layer.provide(store),
  );
  const services = Layer.mergeAll(store, reconciler, watcher, index);

  // One pass at start: a document created outside Corvis is found and indexed
  // before the first call, and a failed pass does not stop the server.
  const startup = Layer.effectDiscard(
    Effect.gen(function* () {
      const docsReconciler = yield* DocsReconciler.DocsReconciler;
      const docsIndex = yield* DocsIndex.DocsIndex;
      const report = yield* docsReconciler
        .reconcile()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`Docs reconcile at startup failed: ${cause}`).pipe(
              Effect.as(null as DocsReconciler.ReconcileReport | null),
            ),
          ),
        );
      if (report !== null) {
        yield* DocsIndex.applyReport(docsIndex, report).pipe(Effect.ignore);
      }
    }),
  );

  // Live edits: the watcher reconciles the store, and every changed file is
  // re-indexed from disk so `docs_search` follows the filesystem.
  const indexing = Layer.effectDiscard(
    Effect.gen(function* () {
      const changes = yield* DocsWatch.DocsWatchService;
      const documents = yield* DocsStore.DocsStore;
      const docsIndex = yield* DocsIndex.DocsIndex;
      yield* Stream.runForEach(changes.changes, (change) =>
        Effect.gen(function* () {
          if (change.kind === "removed") {
            yield* docsIndex.removeDocuments([change.stableId]);
            return;
          }
          const content = yield* documents
            .readDocContent({ relPath: change.relPath })
            .pipe(Effect.orElseSucceed(() => null));
          if (content === null) return;
          yield* docsIndex.indexDocuments([
            {
              stableId: change.stableId,
              relPath: change.relPath,
              title: titleOf(content, change.relPath),
              body: content,
              sha256: sha256Hex(content),
            },
          ]);
        }).pipe(Effect.ignore),
      ).pipe(Effect.forkScoped);
    }),
  );

  return Layer.mergeAll(startup, indexing).pipe(Layer.provideMerge(services));
};
