/**
 * Browser-safe RPC contracts of `ft3-docs`: `docs.resolve` replaces
 * `openContext.resolveDoc` (design §3.2, §6.3). Chat chips resolve an
 * `oc://doc` link through it.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

export const FT3_DOCS_WS_METHODS = {
  docsResolve: "docs.resolve",
} as const;

const DocsStableId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const DocsResolveInput = Schema.Struct({ stableId: DocsStableId });
export type DocsResolveInput = typeof DocsResolveInput.Type;

/**
 * `found` carries the host path the desktop client opens the document with; the
 * store never hands that path to an agent (`docs_resolve` omits it).
 */
export const DocsResolveResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    stableId: DocsStableId,
    relPath: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
    sha256: TrimmedNonEmptyString,
    absolutePath: TrimmedNonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literal("not_found") }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type DocsResolveResult = typeof DocsResolveResult.Type;

export const docsRpcs = [
  Rpc.make(FT3_DOCS_WS_METHODS.docsResolve, {
    payload: DocsResolveInput,
    success: DocsResolveResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;

export const docsRpcScopes = {
  [FT3_DOCS_WS_METHODS.docsResolve]: AuthOrchestrationReadScope,
} as const;
