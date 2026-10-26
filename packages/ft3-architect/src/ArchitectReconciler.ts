import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../../../apps/server/src/serverActivation.ts";
import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as ArchitectService from "./ArchitectService.ts";

export const reconcile = Effect.fn("Ft3ArchitectReconciler.reconcile")(function* () {
  const service = yield* ArchitectService.ArchitectService;
  yield* service.reconcileAfterRestart();
});

export const layerWorker = () =>
  Layer.effectDiscard(
    forkParked(
      reconcile().pipe(
        Effect.tapError(() =>
          Effect.logWarning("Architect reconciler failed; retrying from durable state"),
        ),
        Effect.retry(Schedule.spaced("1 second")),
        Effect.asVoid,
      ),
    ),
  ).pipe(
    Layer.provide(ArchitectService.layer),
    Layer.provide(ArchitectRepository.layer),
    Layer.provide(BoardRepository.layer),
  );
