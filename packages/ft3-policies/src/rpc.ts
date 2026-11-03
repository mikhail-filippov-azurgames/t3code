import { DocsService } from "@t3tools/ft3-docs/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import {
  docsPolicyDocumentReadPort,
  layer as policyDocumentLoaderLayer,
} from "./policyDocumentLoader.ts";
import { PolicyChangeTracker, layer as policyChangeTrackerLayer } from "./policyChangeTracker.ts";
import { readPolicySettings, resolvePolicyDocumentSources } from "./settings.ts";
import {
  FT3_POLICIES_WS_METHODS,
  type PoliciesGetSnapshotInput,
  type PoliciesGetSnapshotResult,
} from "./rpc-contracts.ts";

export { FT3_POLICIES_WS_METHODS, policiesRpcs, policiesRpcScopes } from "./rpc-contracts.ts";
export { PolicyChangeTracker } from "./policyChangeTracker.ts";

/**
 * The snapshot loader reads through the ambient `DocsService`, so the host
 * composition provides the same store the docs RPC uses.
 */
export const policiesRpcServiceLayer: Layer.Layer<PolicyChangeTracker, never, DocsService> =
  Layer.unwrap(
    Effect.map(DocsService, (docs) =>
      policyChangeTrackerLayer.pipe(
        Layer.provide(policyDocumentLoaderLayer(docsPolicyDocumentReadPort(docs))),
      ),
    ),
  );

const getSnapshot = Effect.fn("PoliciesRpc.getSnapshot")(function* (
  _input: PoliciesGetSnapshotInput,
) {
  const tracker = yield* PolicyChangeTracker;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  const policies = readPolicySettings(settings.ft3);
  const snapshot = yield* tracker.refresh({
    sources: resolvePolicyDocumentSources(policies, null),
    features: {
      board: policies.features.board,
      planning: policies.features.planning,
    },
  });
  return {
    configVersion: snapshot.configVersion,
    documents: snapshot.documents,
  } satisfies PoliciesGetSnapshotResult;
});

export const policiesRpcHandlers = {
  [FT3_POLICIES_WS_METHODS.policiesGetSnapshot]: getSnapshot,
};
