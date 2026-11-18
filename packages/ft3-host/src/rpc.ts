import {
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  type ServerSettingsError,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import { planGateLayer, planServiceLayer } from "@t3tools/ft3-board/planning";
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
  docsRpcs,
} from "@t3tools/ft3-docs/rpc";
import { readDocsSettings, resolveDocsRoot } from "@t3tools/ft3-docs/root";
import {
  FT3_MAIL_WS_METHODS,
  mailRpcHandlers,
  mailRpcScopes,
  mailRpcs,
} from "@t3tools/ft3-mail/rpc";
import { layer as mailRepositoryLayer } from "@t3tools/ft3-mail/repository";
import { boardMailFactsLayer } from "@t3tools/ft3-mail/boardMailFacts";
import { layer as mailServiceLayer, layerDocsServiceWithWriteRule } from "./server.ts";
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
  policiesRpcs,
} from "@t3tools/ft3-policies/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { FT3_ZAVOD_WS_METHODS, ZavodRpcError, zavodRpcScopes, zavodRpcs } from "./rpc-contracts.ts";
import * as Zavod from "./zavod/service.ts";
import * as ZavodInstances from "./zavod/instances.ts";
import * as ZavodPersonalCopy from "./zavod/personalCopy.ts";

export { BoardService } from "@t3tools/ft3-board/service";
export { BoardDelegationService } from "@t3tools/ft3-board/delegation";
export { PlanService } from "@t3tools/ft3-board/planning";
export { PlanGate } from "@t3tools/ft3-board/planning";
export { BoardSummaryHistoryService } from "@t3tools/ft3-board/rpc";
export { CommitHistoryService } from "@t3tools/ft3-vcs/service";
export { MailService } from "@t3tools/ft3-mail/service";
export { MailRepository } from "@t3tools/ft3-mail/repository";
export { PolicyChangeTracker, PolicyPickers } from "@t3tools/ft3-policies/rpc";
export { ZavodService } from "./zavod/service.ts";

export const FT3_WS_METHODS = {
  ...FT3_BOARD_WS_METHODS,
  ...FT3_PI_WS_METHODS,
  ...FT3_VCS_WS_METHODS,
  ...FT3_DOCS_WS_METHODS,
  ...FT3_POLICIES_WS_METHODS,
  ...FT3_MAIL_WS_METHODS,
  ...FT3_ZAVOD_WS_METHODS,
} as const;

const ft3RpcScopes = {
  ...boardRpcScopes,
  ...piRpcScopes,
  ...ft3VcsRpcScopes,
  ...docsRpcScopes,
  ...policiesRpcScopes,
  ...mailRpcScopes,
  ...zavodRpcScopes,
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
  ...piRpcs,
  ...ft3VcsRpcs,
  ...docsRpcs,
  ...policiesRpcs,
  ...mailRpcs,
  ...zavodRpcs,
).middleware(Ft3RpcScopeAuthorization);

const zavodRpcError = (
  operation: ZavodRpcError["operation"],
  error:
    | ServerSettingsError
    | ZavodInstances.ZavodInstancesError
    | ZavodPersonalCopy.ZavodPersonalCopyError,
) =>
  new ZavodRpcError({
    operation,
    stage: error._tag === "ServerSettingsError" ? "settings" : error.stage,
    ...(error._tag === "ZavodInstancesError" && error.instanceId !== undefined
      ? { instanceId: error.instanceId }
      : {}),
  });

export const handlers = {
  ...boardRpcHandlers,
  ...piRpcHandlers,
  ...ft3VcsRpcHandlers,
  ...docsRpcHandlers,
  ...policiesRpcHandlers,
  ...mailRpcHandlers,
  [FT3_ZAVOD_WS_METHODS.zavodDetect]: () =>
    Effect.flatMap(Zavod.ZavodService, (service) => service.detect()).pipe(
      Effect.mapError((error) => zavodRpcError("detect", error)),
    ),
  [FT3_ZAVOD_WS_METHODS.zavodConnect]: () =>
    Effect.flatMap(Zavod.ZavodService, (service) => service.connect()).pipe(
      Effect.mapError((error) => zavodRpcError("connect", error)),
    ),
  [FT3_ZAVOD_WS_METHODS.zavodCopyPersonal]: ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.flatMap(Zavod.ZavodService, (service) => service.copyPersonal({ dryRun })).pipe(
      Effect.mapError((error) => zavodRpcError("copy", error)),
    ),
};

export const zavodRpcServiceLayer = Zavod.layer.pipe(Layer.provide(ZavodInstances.layer));

// The store root is a setting (`ft3.docs.root`), so it can point at the store
// the machine already has instead of the empty state-directory one.
const docsRoot = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.orDie);
  return resolveDocsRoot({
    stateDir: config.stateDir,
    configuredRoot: readDocsSettings(current.ft3).root,
  });
});

const docsServiceLayer = Layer.unwrap(
  Effect.map(docsRoot, (root) => layerDocsServiceWithWriteRule(root)),
);

// The plan summaries read document metadata through the store directly.
const rpcServices = Layer.mergeAll(
  boardRpcServiceLayer,
  piRpcServiceLayer,
  ft3VcsRpcServiceLayer,
  docsServiceLayer,
  // The mail handlers take MailService from the host mail stack and read the
  // task row through MailRepository.
  mailServiceLayer,
  mailRepositoryLayer,
  zavodRpcServiceLayer,
);

// BoardService and the RPC handlers read PlanService through the gate layer;
// plan facts come from the mail repository, so the board never queries mail
// tables directly and reads empty without mail tables.
const mailFacts = boardMailFactsLayer.pipe(Layer.provide(mailRepositoryLayer));
const planServices = planGateLayer.pipe(
  Layer.provideMerge(planServiceLayer.pipe(Layer.provide(mailFacts))),
);

export const serviceLayer = rpcServices.pipe(Layer.provideMerge(planServices));
