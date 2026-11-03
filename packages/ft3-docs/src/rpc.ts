import * as Effect from "effect/Effect";

import { DocsResolveInput, DocsResolveResult, FT3_DOCS_WS_METHODS } from "./rpc-contracts.ts";
import * as Service from "./service.ts";

export { FT3_DOCS_WS_METHODS, docsRpcs, docsRpcScopes } from "./rpc-contracts.ts";

export interface DocsRpcOptions {
  /** Store root resolved by the host from `ft3.docs.root` or the state directory. */
  readonly root: string;
}

/**
 * The store for the RPC composition. The store keeps its own SQLite client on
 * `opencontext.db`; the reconciler and the index use the ambient `statev2`
 * client, which the RPC composition provides.
 */
export const docsRpcServiceLayer = (options: DocsRpcOptions) =>
  Service.layerWithDefaultPorts({ root: options.root });

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
