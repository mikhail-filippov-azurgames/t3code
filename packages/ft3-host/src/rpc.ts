import {
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import {
  FT3_ARCHITECT_WS_METHODS,
  architectRpcHandlers,
  architectRpcs,
  architectRpcScopes,
  architectRpcServiceLayer,
} from "@t3tools/ft3-architect/rpc";
import {
  FT3_BOARD_WS_METHODS,
  boardRpcHandlers,
  boardRpcScopes,
  boardRpcServiceLayer,
  boardRpcs,
} from "@t3tools/ft3-board/rpc";
import {
  FT3_DOCS_WS_METHODS,
  docsRpcHandlers,
  docsRpcScopes,
  docsRpcServiceLayer,
  docsRpcs,
} from "@t3tools/ft3-docs/rpc";
import { readDocsSettings, resolveDocsRoot } from "@t3tools/ft3-docs/root";
import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import {
  FT3_VCS_WS_METHODS,
  ft3VcsRpcHandlers,
  ft3VcsRpcScopes,
  ft3VcsRpcServiceLayer,
  ft3VcsRpcs,
} from "@t3tools/ft3-vcs/rpc";
import {
  FT3_PI_WS_METHODS,
  piRpcHandlers,
  piRpcScopes,
  piRpcServiceLayer,
  piRpcs,
} from "@t3tools/ft3-pi/rpc";
import {
  FT3_POLICIES_WS_METHODS,
  policiesRpcHandlers,
  policiesRpcScopes,
  policiesRpcServiceLayer,
  policiesRpcs,
} from "@t3tools/ft3-policies/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

export { ArchitectService } from "@t3tools/ft3-architect/service";
export { BoardService } from "@t3tools/ft3-board/service";
export { BoardDelegationService } from "@t3tools/ft3-board/delegation";
export { BoardSummaryHistoryService } from "@t3tools/ft3-board/rpc";
export { CommitHistoryService } from "@t3tools/ft3-vcs/service";
export { PolicyChangeTracker } from "@t3tools/ft3-policies/rpc";

export const FT3_WS_METHODS = {
  ...FT3_BOARD_WS_METHODS,
  ...FT3_ARCHITECT_WS_METHODS,
  ...FT3_PI_WS_METHODS,
  ...FT3_VCS_WS_METHODS,
  ...FT3_DOCS_WS_METHODS,
  ...FT3_POLICIES_WS_METHODS,
} as const;

const ft3RpcScopes = {
  ...boardRpcScopes,
  ...architectRpcScopes,
  ...piRpcScopes,
  ...ft3VcsRpcScopes,
  ...docsRpcScopes,
  ...policiesRpcScopes,
} as const;

export class Ft3RpcScopeAuthorization extends RpcMiddleware.Service<Ft3RpcScopeAuthorization>()(
  "t3/ft3/Ft3RpcScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

const requiredScopeForFt3Method = (method: string): AuthEnvironmentScope => {
  const scope = ft3RpcScopes[method as keyof typeof ft3RpcScopes];
  if (scope === undefined) {
    throw new Error(`FT3 RPC method ${method} has no declared authorization scope.`);
  }
  return scope;
};

export const authorizationLayer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(Ft3RpcScopeAuthorization)((effect, { rpc }) => {
    const required = requiredScopeForFt3Method(rpc._tag);
    if (!scopes.includes(required)) return Effect.fail(rpcAuthorizationError(required));
    return effect;
  });

export const group = RpcGroup.make(
  ...boardRpcs,
  ...architectRpcs,
  ...piRpcs,
  ...ft3VcsRpcs,
  ...docsRpcs,
  ...policiesRpcs,
).middleware(Ft3RpcScopeAuthorization);

export const handlers = {
  ...boardRpcHandlers,
  ...architectRpcHandlers,
  ...piRpcHandlers,
  ...ft3VcsRpcHandlers,
  ...docsRpcHandlers,
  ...policiesRpcHandlers,
};

// The store root is a setting (`ft3.docs.root`), so it can point at the store
// the machine already has instead of the empty state-directory one.
const docsServiceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(Effect.orDie);
    return docsRpcServiceLayer({
      root: resolveDocsRoot({
        stateDir: config.stateDir,
        configuredRoot: readDocsSettings(current.ft3).root,
      }),
    });
  }),
);

export const serviceLayer = Layer.mergeAll(
  boardRpcServiceLayer,
  architectRpcServiceLayer,
  piRpcServiceLayer,
  ft3VcsRpcServiceLayer,
  docsServiceLayer,
  policiesRpcServiceLayer.pipe(Layer.provide(docsServiceLayer)),
);
