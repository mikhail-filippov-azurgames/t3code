import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardRepository from "@t3tools/ft3-board/repository";

export { runMigrations } from "./Migrations.ts";

export { BoardRepository };

export const layer = BoardRepository.layer;

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
] as const;
