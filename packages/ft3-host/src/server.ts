import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import { startupRoleConfiguration } from "@t3tools/ft3-delegation/server";
import { setDocumentsBriefEnabled } from "@t3tools/ft3-docs/brief";
import { readDocsSettings, resolveDocsRoot } from "@t3tools/ft3-docs/root";
import * as FeatureGate from "@t3tools/ft3-policies/server";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";

export { runMigrations } from "./Migrations.ts";
export { drainProcessOutput, type ProcessOutput } from "./processOutput.ts";

export { BoardRepository };

// Feature-driven startup: roles off keeps upstream role behavior; documents off
// leaves the store unread and the document brief block out of agent briefs.
const layerStartup = Layer.unwrap(
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    const rolesEffective = yield* gate.isEffective("roles");
    setDocumentsBriefEnabled(yield* gate.isEffective("documents"));
    return rolesEffective ? Layer.effectDiscard(startupRoleConfiguration) : Layer.empty;
  }),
).pipe(Layer.provide(FeatureGate.layer));

/**
 * The document store runtime: one reconcile pass, the recursive watcher and the
 * FTS index over this server's store root, started only while `documents` is
 * effective. A store that cannot be opened leaves the feature off instead of
 * stopping the server.
 */
const layerDocuments = Layer.unwrap(
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    if (!(yield* gate.isEffective("documents"))) return Layer.empty;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(Effect.orDie);
    const docs = yield* Effect.promise(() => import("@t3tools/ft3-docs/server"));
    return docs.docsRuntimeLayer({
      root: resolveDocsRoot({
        stateDir: config.stateDir,
        configuredRoot: readDocsSettings(current.ft3).root,
      }),
    });
  }),
).pipe(
  // A store that cannot be opened leaves documents off instead of stopping the server.
  Layer.catchCause((cause) =>
    Layer.effectDiscard(
      Effect.logWarning(`Documents are on, but the store did not start: ${cause}`),
    ),
  ),
  Layer.provide(FeatureGate.layer),
);

// Startup seam: an unusable roles directory fails here, and roles disable native subagents.
export const layer = Layer.mergeAll(
  BoardRepository.layer,
  layerStartup,
  layerDocuments,
  FeatureGate.layer,
);

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

// The docs toolkit reads and writes the store; `documents` off refuses every call.
const layerDocsToolkit = Layer.unwrap(
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(Effect.orDie);
    const docs = yield* Effect.promise(() => import("@t3tools/ft3-docs/server"));
    return docs.docsMcpLayer({
      root: resolveDocsRoot({
        stateDir: config.stateDir,
        configuredRoot: readDocsSettings(current.ft3).root,
      }),
      requireEnabled: gate
        .require("documents")
        .pipe(
          Effect.mapError(
            (error) =>
              new docs.DocsMcpFailure({ code: "feature_disabled", message: error.message }),
          ),
        ),
    });
  }),
).pipe(
  Layer.catchCause((cause) =>
    Layer.effectDiscard(Effect.logWarning(`The docs toolkit is unavailable: ${cause}`)),
  ),
  Layer.provide(FeatureGate.layer),
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
  layerDocsToolkit,
] as const;
