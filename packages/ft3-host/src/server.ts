import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import { boardMailFactsLayer } from "@t3tools/ft3-mail/boardMailFacts";
import { layer as mailRepositoryLayer } from "@t3tools/ft3-mail/repository";
import { applyNativeSubagentGuidance } from "@t3tools/ft3-delegation/server";
import { setDocumentsBriefEnabled } from "@t3tools/ft3-docs/brief";
import { readDocsSettings, resolveDocsRoot } from "@t3tools/ft3-docs/root";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import { roleResolverLayer, withRefreshHook } from "@t3tools/ft3-policies/server";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";

export { hasPendingMigrations, runMigrations } from "./Migrations.ts";
export { drainProcessOutput, type ProcessOutput } from "./processOutput.ts";
export { Ft3ClaudeDriver, Ft3CodexDriver } from "./zavod/drivers.ts";

// The mail stack takes PlanService, which writes plan documents through the
// store. Same docs root as rpc.ts, created here because a fresh state
// directory has no documents folder yet.
const layerDocsService = Layer.unwrap(
  Effect.gen(function* () {
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
    return layerDocsServiceWithWriteRule(root);
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

/**
 * The `documents:write` inputs the host composes once (design §3.5): role, plan
 * identity and grant from the plan record and the mail task, and protection for
 * protected documents. The docs toolkit and the plan stack both take them.
 */
const documentsWriteRule = Effect.fn("ft3.documentsWriteRule")(function* (root: string) {
  const docs = yield* Effect.promise(() => import("@t3tools/ft3-docs/server"));
  const mail = yield* Effect.promise(() => import("@t3tools/ft3-mail/server"));
  const planning = yield* Effect.promise(() => import("@t3tools/ft3-board/planning"));
  const settings = yield* ServerSettings.ServerSettingsService;
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
  // service refuses the agent write, while reads stay available.
  const protection = docsProtectionLayer(docs, root).pipe(
    Layer.provide(docs.docsStoreLayer({ root })),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
    Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, settings)),
    // A store that cannot open fails the service the same way; the defect surfaces here.
    Layer.orDie,
  );
  return { writeFacts, protection };
});

/**
 * The store's DocsService under the lineage rule and protection, the composition
 * the docs toolkit builds for agents. PlanService writes plan documents through
 * whichever DocsService the layer graph hands it, so every DocsService the host
 * provides takes this rule; reads do not depend on it.
 */
export const layerDocsServiceWithWriteRule = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const docs = yield* Effect.promise(() => import("@t3tools/ft3-docs/server"));
      const { writeFacts, protection } = yield* documentsWriteRule(root);
      return docs
        .docsServiceLayer({ root })
        .pipe(
          Layer.provide(docs.documentsWriteAccessLayer.pipe(Layer.provide(writeFacts))),
          Layer.provide(protection),
          Layer.provide(docsChangeBus),
        );
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
    const docsService = layerDocsServiceWithWriteRule(root).pipe(
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
    return Layer.mergeAll(
      policies.policyPickersLayer.pipe(Layer.provideMerge(trackerWithGuidance)),
      roleResolverLayer,
    ).pipe(
      Layer.tap((context) =>
        Effect.gen(function* () {
          yield* policies.refreshAppliedPolicies.pipe(
            Effect.provide(context),
            Effect.catchCause((cause) =>
              Effect.logWarning(`Applied policies were not refreshed at startup: ${cause}`),
            ),
          );
          // Project scopes restore next, so a restart never serves such a
          // project "off until Policies opened" (plan P3).
          yield* policies.refreshAppliedProjectPolicies.pipe(
            Effect.provide(context),
            Effect.catchCause((cause) =>
              Effect.logWarning(`Project policy scopes were not refreshed at startup: ${cause}`),
            ),
          );
        }),
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

// The nudge reactor reads mail facts through the board port, so the board
// never queries mail tables directly; without mail tables the facts read empty.
const nudgeMailFacts = boardMailFactsLayer.pipe(Layer.provide(mailRepositoryLayer));
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
        Effect.map((module) => module.layerWorker().pipe(Layer.provide(nudgeMailFacts))),
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
    const { writeFacts, protection } = yield* documentsWriteRule(root);
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
