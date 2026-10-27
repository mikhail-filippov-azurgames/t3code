import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { resolveOpenContextDoc } from "./openContextDocs.ts";

export const FT3_OPENCONTEXT_WS_METHODS = {
  openContextResolveDoc: "openContext.resolveDoc",
} as const;

const OpenContextDocStableId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const OpenContextResolveDocInput = Schema.Struct({
  stableId: OpenContextDocStableId,
});
export type OpenContextResolveDocInput = typeof OpenContextResolveDocInput.Type;

export const OpenContextResolveDocResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    stableId: OpenContextDocStableId,
    name: OpenContextDocStableId,
    relativePath: OpenContextDocStableId,
    absolutePath: OpenContextDocStableId,
  }),
  Schema.Struct({ status: Schema.Literal("not_found") }),
  Schema.Struct({ status: Schema.Literal("store_unavailable") }),
]);
export type OpenContextResolveDocResult = typeof OpenContextResolveDocResult.Type;

export const openContextRpcs = [
  Rpc.make(FT3_OPENCONTEXT_WS_METHODS.openContextResolveDoc, {
    payload: OpenContextResolveDocInput,
    success: OpenContextResolveDocResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;

export const openContextRpcScopes = {
  [FT3_OPENCONTEXT_WS_METHODS.openContextResolveDoc]: AuthOrchestrationReadScope,
} as const;

export const openContextRpcHandlers = {
  [FT3_OPENCONTEXT_WS_METHODS.openContextResolveDoc]: (input: OpenContextResolveDocInput) =>
    Effect.promise(() => resolveOpenContextDoc(input.stableId)),
};
