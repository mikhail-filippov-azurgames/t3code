import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import { applyNativeSubagentGuidance } from "@t3tools/ft3-delegation/server";
import { setDocumentsBriefEnabled } from "@t3tools/ft3-docs/brief";
import { readDocsSettings, resolveDocsRoot } from "@t3tools/ft3-docs/root";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import { roleResolverLayer, withRefreshHook } from "@t3tools/ft3-policies/server";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";

export { runMigrations } from "./Migrations.ts";
export { drainProcessOutput, type ProcessOutput } from "./processOutput.ts";

export { BoardRepository };

// Documents off leaves the store unread and the document brief block out of agent briefs.
const layerStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    setDocumentsBriefEnabled(yield* gate.isEffective("documents"));
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

/**
 * Applied policies for the whole server: one tracker that the Policies RPC,
 * delegation and the board all read, refreshed once here. Every refresh, startup
 * or Apply, also sets the native-subagent guidance from the applied roles.
 */
const layerAppliedPolicies = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(Effect.orDie);
    const [docs, policies] = yield* Effect.all([
      Effect.promise(() => import("@t3tools/ft3-docs/server")),
      Effect.promise(() => import("@t3tools/ft3-policies/rpc")),
    ]);
    const root = resolveDocsRoot({
      stateDir: config.stateDir,
      configuredRoot: readDocsSettings(current.ft3).root,
    });
    // A store that cannot be opened leaves roles off instead of stopping the server:
    // the tracker still serves, and every document read reports the store unavailable.
    const storeOff = Effect.fn("DocsService.storeUnavailable")(() =>
      Effect.fail(new docs.DocsServiceError({ code: "store_unavailable" })),
    );
    const unavailableDocs = docs.DocsService.of({
      list: storeOff,
      manifest: storeOff,
      read: storeOff,
      resolve: storeOff,
      search: storeOff,
      write: storeOff,
      writeAsHuman: storeOff,
      locateServerPath: Effect.fn("DocsService.storeUnavailable.locate")(() =>
        Effect.succeed(null),
      ),
      setDescription: storeOff,
      docRef: storeOff,
    });
    const docsService = docs
      .docsRpcServiceLayer({ root })
      .pipe(
        Layer.catchCause((cause) =>
          Layer.effect(
            docs.DocsService,
            Effect.logWarning(`The policy document store did not open: ${cause}`).pipe(
              Effect.as(unavailableDocs),
            ),
          ),
        ),
      );
    const trackerWithGuidance = withRefreshHook((tracker) =>
      tracker
        .snapshot()
        .pipe(
          Effect.flatMap((snapshot) =>
            applyNativeSubagentGuidance(
              snapshot.documents.find((document) => document.key === "roles")?.configured === true,
            ),
          ),
        ),
    ).pipe(Layer.provide(policies.policiesRpcServiceLayer), Layer.provideMerge(docsService));
    return Layer.mergeAll(trackerWithGuidance, roleResolverLayer).pipe(
      Layer.tap((context) =>
        policies.refreshAppliedPolicies.pipe(
          Effect.provide(context),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Applied policies were not refreshed at startup: ${cause}`),
          ),
        ),
      ),
    );
  }),
);

// Mail reads the applied policies and the board, so it takes both from the layers beside it.
const layerMail = Layer.unwrap(
  Effect.promise(() => import("@t3tools/ft3-mail/server")).pipe(Effect.map((mail) => mail.layer)),
);

export const layer = layerMail.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      BoardRepository.layer,
      layerStartup,
      layerDocuments,
      layerAppliedPolicies,
      FeatureGate.layer,
    ),
  ),
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
    const mail = yield* Effect.promise(() => import("@t3tools/ft3-mail/server"));
    const sql = yield* SqlClient.SqlClient;
    return docs.docsMcpLayer({
      root: resolveDocsRoot({
        stateDir: config.stateDir,
        configuredRoot: readDocsSettings(current.ft3).root,
      }),
      writeFacts: mail.documentsWriteFacts.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      ),
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
