import * as Effect from "effect/Effect";

import { resolveDocsRoot } from "./root.ts";
import { DocsResolveInput, DocsResolveResult, FT3_DOCS_WS_METHODS } from "./rpc-contracts.ts";
import * as Service from "./service.ts";

export { FT3_DOCS_WS_METHODS, docsRpcs, docsRpcScopes } from "./rpc-contracts.ts";

export interface DocsRpcOptions {
  /** The server state directory the store lives under when no root is configured. */
  readonly stateDir: string;
}

/**
 * The store for the RPC composition. The store keeps its own SQLite client on
 * `opencontext.db`; the reconciler and the index use the ambient `statev2`
 * client, which the RPC composition provides.
 */
export const docsRpcServiceLayer = (options: DocsRpcOptions) =>
  Service.layerWithDefaultPorts({ root: resolveDocsRoot({ stateDir: options.stateDir }) });

const docsResolve = Effect.fn("DocsRpc.docsResolve")(function* (input: DocsResolveInput) {
  const service = yield* Service.DocsService;
  return yield* service.resolve({ ref: `oc://doc/${input.stableId}` }).pipe(
    Effect.map((resolved): DocsResolveResult => ({
      status: "found",
      stableId: resolved.document.stableId,
      relPath: resolved.document.relPath,
      name: resolved.document.name,
      sha256: resolved.document.sha256,
      absolutePath: resolved.absolutePath,
    })),
    Effect.catch((error): Effect.Effect<DocsResolveResult> =>
      Effect.succeed({
        status: error.code === "document_not_found" ? "not_found" : "unavailable",
      }),
    ),
  );
});

export const docsRpcHandlers = {
  [FT3_DOCS_WS_METHODS.docsResolve]: docsResolve,
};
