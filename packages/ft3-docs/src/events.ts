/**
 * The subscriber-facing document change stream: watch reconciliations and
 * service-side writes publish here, so a subscriber that never touches the
 * filesystem still sees every change.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { DocsChanged } from "./reconciler.ts";

export class DocsChangeBus extends Context.Service<
  DocsChangeBus,
  {
    readonly publish: (change: DocsChanged) => Effect.Effect<void>;
    readonly changes: Stream.Stream<DocsChanged>;
  }
>()("@t3tools/ft3-docs/events/DocsChangeBus") {}

/** A live bus: every published change reaches every running subscriber. */
export const layer = (): Layer.Layer<DocsChangeBus> =>
  Layer.effect(
    DocsChangeBus,
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<DocsChanged>();
      return DocsChangeBus.of({
        publish: Effect.fn("DocsChangeBus.publish")((change: DocsChanged) =>
          PubSub.publish(events, change).pipe(Effect.asVoid),
        ),
        changes: Stream.fromPubSub(events),
      });
    }),
  );
