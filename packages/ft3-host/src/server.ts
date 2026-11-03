import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import { startupRoleConfiguration } from "@t3tools/ft3-delegation/server";
import * as FeatureGate from "@t3tools/ft3-policies/server";

export { runMigrations } from "./Migrations.ts";
export { drainProcessOutput, type ProcessOutput } from "./processOutput.ts";

export { BoardRepository };

// A roles toggle that is off keeps upstream role behavior: no ft3 role startup.
const layerRolesStartup = Layer.unwrap(
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    const rolesEffective = yield* gate.isEffective("roles");
    return rolesEffective ? Layer.effectDiscard(startupRoleConfiguration) : Layer.empty;
  }),
).pipe(Layer.provide(FeatureGate.layer));

// Startup seam: an unusable roles directory fails here, and roles disable native subagents.
export const layer = Layer.mergeAll(BoardRepository.layer, layerRolesStartup, FeatureGate.layer);

export const boardReactorLayer = () =>
  Layer.unwrap(
    Effect.promise(() => import("@t3tools/ft3-board/reactor")).pipe(
      Effect.map((module) => module.layerWorker()),
    ),
  );

export const reactorLayer = () =>
  Layer.mergeAll(
    boardReactorLayer(),
    Layer.unwrap(
      Effect.promise(() => import("@t3tools/ft3-board/automation")).pipe(
        Effect.map((module) => module.layerWorker()),
      ),
    ),
    Layer.unwrap(
      Effect.promise(() => import("@t3tools/ft3-architect/reactor")).pipe(
        Effect.map((module) => module.layerWorker()),
      ),
    ),
    Layer.unwrap(
      Effect.promise(() => import("@t3tools/ft3-orchestration/reactor")).pipe(
        Effect.map((module) => module.layerWorker()),
      ),
    ),
  );

// Load after upstream module initialization to avoid the server composition cycle.
export const mcpToolkits = [
  Layer.unwrap(
    Effect.promise(() => import("@t3tools/ft3-orchestration/server")).pipe(
      Effect.map((module) => module.layer),
    ),
  ),
  Layer.unwrap(
    Effect.promise(() => import("@t3tools/ft3-board/server")).pipe(
      Effect.map((module) => module.layer),
    ),
  ),
  Layer.unwrap(
    Effect.promise(() => import("@t3tools/ft3-architect/server")).pipe(
      Effect.map((module) => module.layer),
    ),
  ),
] as const;
