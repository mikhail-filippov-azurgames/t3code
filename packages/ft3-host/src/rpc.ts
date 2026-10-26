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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

export { ArchitectService } from "@t3tools/ft3-architect/service";
export { BoardService } from "@t3tools/ft3-board/service";

export const FT3_WS_METHODS = {
  ...FT3_BOARD_WS_METHODS,
  ...FT3_ARCHITECT_WS_METHODS,
} as const;

const ft3RpcScopes = { ...boardRpcScopes, ...architectRpcScopes } as const;

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

export const group = RpcGroup.make(...boardRpcs, ...architectRpcs).middleware(
  Ft3RpcScopeAuthorization,
);

export const handlers = { ...boardRpcHandlers, ...architectRpcHandlers };

export const serviceLayer = Layer.merge(boardRpcServiceLayer, architectRpcServiceLayer);
