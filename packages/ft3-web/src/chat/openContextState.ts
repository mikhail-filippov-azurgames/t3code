import { connectionAtomRuntime } from "~/connection/runtime";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRpcSuccess } from "@t3tools/client-runtime/rpc";

import type { OpenContextDocResolveResult } from "./openContextDocLink.ts";

export const FT3_OPENCONTEXT_RESOLVE_DOC = "openContext.resolveDoc" as const;

export const openContextEnvironment = {
  resolveDoc: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:opencontext:resolve-doc",
    tag: FT3_OPENCONTEXT_RESOLVE_DOC,
    staleTimeMs: 15_000,
  }),
};

export type OpenContextResolveDocQueryResult = EnvironmentRpcSuccess<
  typeof FT3_OPENCONTEXT_RESOLVE_DOC
>;

export function toOpenContextDocResolveResult(
  value: OpenContextResolveDocQueryResult,
): OpenContextDocResolveResult {
  return value;
}
