import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export { runMigrations } from "./Migrations.ts";

export const layer = Layer.empty;

// Load after upstream module initialization to avoid the server composition cycle.
export const mcpToolkits = [
  Layer.unwrap(
    Effect.promise(() => import("@t3tools/ft3-orchestration/server")).pipe(
      Effect.map((module) => module.layer),
    ),
  ),
] as const;
