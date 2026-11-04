// @effect-diagnostics nodeBuiltinImport:off - watching the store tree needs a recursive OS watcher.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as DocsEvents from "./events.ts";
import { DocsReconciler, type DocsChanged } from "./reconciler.ts";

export interface DocsWatchEvent {
  /** Absolute path of the changed entry; `contextsRoot` itself for watcher errors. */
  readonly path: string;
  /** Watcher-level failure or overflow: triggers a full reconcile pass. */
  readonly failed: boolean;
}

export interface DocsWatchOptions {
  /** Store root: `contexts/` is watched recursively. */
  readonly root: string;
  /** Debounce after the last watch event before reconciling (default 250 ms, design §3.3). */
  readonly debounce?: Duration.Input;
  /** Raw watch events; defaults to a recursive `node:fs` watcher on `contexts/`. Tests inject this. */
  readonly events?: Stream.Stream<DocsWatchEvent, never>;
  /**
   * Shared change bus the reconcile reports publish to. A fresh bus is
   * created when omitted, so the watcher still works standalone.
   */
  readonly bus?: Layer.Layer<DocsEvents.DocsChangeBus>;
}

const make = Effect.fn("DocsWatchService.make")(function* (options: DocsWatchOptions) {
  const reconciler = yield* DocsReconciler;
  const bus = yield* DocsEvents.DocsChangeBus;
  const contextsRoot = NodePath.resolve(options.root, "contexts");
  const debounce = options.debounce ?? Duration.millis(250);

  const rawEvents = yield* Queue.unbounded<DocsWatchEvent>();
  if (options.events === undefined) {
    const watcher = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.watch(contextsRoot, { recursive: true }, (_eventType, filename) => {
          Queue.offerUnsafe(
            rawEvents,
            filename === null
              ? { path: contextsRoot, failed: true }
              : { path: NodePath.resolve(contextsRoot, filename.toString()), failed: false },
          );
        }),
      ),
      (handle) => Effect.sync(() => handle.close()),
    );
    watcher.on("error", () => {
      Queue.offerUnsafe(rawEvents, { path: contextsRoot, failed: true });
    });
  }

  const publish = (report: {
    readonly changed: ReadonlyArray<DocsChanged>;
    readonly removed: ReadonlyArray<DocsChanged>;
  }) =>
    Effect.forEach([...report.changed, ...report.removed], (entry) => bus.publish(entry)).pipe(
      Effect.asVoid,
    );

  const pipeline = (options.events ?? Stream.fromQueue(rawEvents)).pipe(
    Stream.filter((event) => event.failed || !reconciler.isSelfWrite(event.path)),
    Stream.debounce(debounce),
    Stream.mapEffect(() =>
      reconciler.reconcile().pipe(
        Effect.tapError((cause) => Effect.logWarning(`Docs reconcile failed: ${cause}`)),
        Effect.tap(publish),
        Effect.ignore,
      ),
    ),
  );

  yield* Effect.forkScoped(Stream.runDrain(pipeline)).pipe(Effect.asVoid);

  return DocsWatchService.of({
    changes: bus.changes,
  });
});

export class DocsWatchService extends Context.Service<
  DocsWatchService,
  {
    /** Documents that changed on disk, after each debounced reconcile pass. */
    readonly changes: Stream.Stream<DocsChanged, never>;
  }
>()("@t3tools/ft3-docs/watch/DocsWatchService") {}

/**
 * Watches `contexts/` recursively and reconciles after a 250 ms debounce; a
 * watcher failure triggers a full pass (design §3.3). Requires `DocsReconciler`.
 */
export const layer = (options: DocsWatchOptions) =>
  Layer.effect(DocsWatchService, make(options)).pipe(
    Layer.provide(options.bus ?? DocsEvents.layer()),
  );
