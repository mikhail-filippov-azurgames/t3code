import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import { ARCHITECT_SKILL_PATH } from "@t3tools/ft3-architect/skillLocation";

export { runMigrations } from "./Migrations.ts";

export { BoardRepository };

export const layer = BoardRepository.layer;

export const reactorLayer = () =>
  Layer.unwrap(
    Effect.promise(() => import("@t3tools/ft3-board/reactor")).pipe(
      Effect.map((module) => module.layerWorker(ARCHITECT_SKILL_PATH)),
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
