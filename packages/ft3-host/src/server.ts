import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import { applyNativeSubagentGuidance } from "@t3tools/ft3-delegation/server";
import { setDocumentsBriefEnabled } from "@t3tools/ft3-docs/brief";
import { readDocsSettings, resolveDocsRoot } from "@t3tools/ft3-docs/root";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import { roleResolverLayer, withRefreshHook } from "@t3tools/ft3-policies/server";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";

export { runMigrations } from "./Migrations.ts";
export { drainProcessOutput, type ProcessOutput } from "./processOutput.ts";

// The mail stack takes PlanService, which reads plan documents through the
// store. Same docs root as rpc.ts, created here because a fresh state
// directory has no documents folder yet.
const layerDocsService = Layer.unwrap(
  Effect.gen(function* () {
    const docs = yield* Effect.promise(() => import("@t3tools/ft3-docs/rpc"));
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const current = yield* settings.getSettings.pipe(Effect.orDie);
    const root = resolveDocsRoot({
      stateDir: config.stateDir,
      configuredRoot: readDocsSettings(current.ft3).root,
    });
    // The store resolves paths under contexts/, so the whole branch must
    // exist before the service opens it; the reconciler creates it as well.
    yield* fs.makeDirectory(path.join(root, "contexts"), { recursive: true });
    return docs.docsRpcServiceLayer({ root });
  }),
);

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
/**
 * One change bus for the whole server: the docs runtime (watch reports) and
 * the docs toolkit (service-side writes) publish to the same bus, so a
 * subscriber that never touches the filesystem still sees every change. The
 * single shared layer value keeps one bus instance per server build.
 */
const docsChangeBus = Layer.unwrap(
  Effect.map(
    Effect.promise(() => import("@t3tools/ft3-docs/server")),
    (docs) => docs.docsChangeBusLayer(),
  ),
);

/**
 * Per-call protected-document identities over this store and board table.
 * A lookup the identities need can fail; the failure refuses the agent
 * write instead of reading as no identity (design §3.4).
 */
export const docsProtectionLayer = (
  docs: typeof import("@t3tools/ft3-docs/server"),
  root: string,
) =>
  Layer.effect(
    docs.DocsProtection,
    Effect.gen(function* () {
      const store = yield* docs.DocsStore;
      const state = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      return docs.DocsProtection.of({
        isProtected: Effect.fn("DocsProtection.isProtected")(function* (document: {
          readonly stableId: string;
          readonly relPath: string;
        }) {
          const live = yield* serverSettings.getSettings.pipe(Effect.orDie);
          const sources = FeatureGate.resolvePolicyDocumentSources(
            FeatureGate.readPolicySettings(live.ft3),
          );
          const platform = yield* HostProcess.Platform;
          const identities = yield* FeatureGate.resolveProtectedIdentities(sources, root, {
            manifestRelPathOf: (stableId) =>
              store.getByStableId(stableId).pipe(
                Effect.map((manifest) => manifest?.relPath ?? null),
                Effect.tapError((cause) =>
                  Effect.logWarning(
                    `Protected-document manifest lookup failed; refusing the write: ${cause}`,
                  ),
                ),
                Effect.mapError(() => new docs.DocsServiceError({ code: "store_unavailable" })),
              ),
            planStableIds: state<{ readonly plan_doc_id: string }>`
              SELECT plan_doc_id FROM ft3_board_card_plans
            `.pipe(
              Effect.map((rows) => rows.map((row) => row.plan_doc_id)),
              Effect.tapError((cause) =>
                Effect.logWarning(
                  `Protected plan-document lookup failed; refusing the write: ${cause}`,
                ),
              ),
              Effect.mapError(() => new docs.DocsServiceError({ code: "store_unavailable" })),
            ),
          });
          return FeatureGate.isProtectedDocument(identities, document, platform);
        }),
      });
    }),
  );

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
      bus: docsChangeBus,
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
      docStat: storeOff,
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
      layerDocsService,
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

export const mailReactorLayer = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const reactor = yield* Effect.promise(() => import("@t3tools/ft3-mail/reactor"));
      // Shares the host mail stack, so the reactor sees the same tasks the tools write.
      return reactor.layerWorker().pipe(Layer.provide(layer));
    }),
  );

export const mailTimeoutReactorLayer = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const reactor = yield* Effect.promise(() => import("@t3tools/ft3-mail/timeoutReactor"));
      // Shares the host mail stack, so the scan fails the same deliveries the tools record.
      return reactor.layerWorker().pipe(Layer.provide(layer));
    }),
  );

export const reactorLayer = () =>
  Layer.mergeAll(
    boardReactorLayer(),
    mailReactorLayer(),
    mailTimeoutReactorLayer(),
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
    const root = resolveDocsRoot({
      stateDir: config.stateDir,
      configuredRoot: readDocsSettings(current.ft3).root,
    });
    const docs = yield* Effect.promise(() => import("@t3tools/ft3-docs/server"));
    const mail = yield* Effect.promise(() => import("@t3tools/ft3-mail/server"));
    const planning = yield* Effect.promise(() => import("@t3tools/ft3-board/planning"));
    const sql = yield* SqlClient.SqlClient;
    // The planner's plan identity comes from the plan record table, the role
    // and grant from the mail task; the combined port keeps a planner that is
    // also a mail participant confined to its own plan document (design §3.5).
    const writeFacts = docs.combineDocumentsWriteFacts(
      planning.planningDocumentsWriteFactsSql.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      ),
      mail.documentsWriteFacts.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
    );
    // Fail closed when the protected identities cannot be established: the
    // service below refuses the agent write, while reads stay available.
    const protection = docsProtectionLayer(docs, root).pipe(
      Layer.provide(docs.docsStoreLayer({ root })),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, settings)),
      // A store that cannot open fails the service below the same way, so the
      // toolkit stays down either way; the failure shows up as a defect here.
      Layer.orDie,
    );
    return docs.docsMcpLayer({
      root,
      writeFacts,
      protection,
      events: docsChangeBus,
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
  // Mail tools act as the calling thread and refuse with mail_disabled_notice
  // while the mail feature is off. Built on the host mail stack, which carries
  // the board and policy pieces the raw package layer leaves open.
  Layer.unwrap(
    Effect.gen(function* () {
      const mail = yield* Effect.promise(() => import("@t3tools/ft3-mail/mcp"));
      return mail.mailMcpLayerFrom(layer, FeatureGate.layer);
    }),
  ),
] as const;
