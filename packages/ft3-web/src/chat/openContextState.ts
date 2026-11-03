import { connectionAtomRuntime } from "~/connection/runtime";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRpcSuccess } from "@t3tools/client-runtime/rpc";

import type { OpenContextDocResolveResult } from "./openContextDocLink.ts";

/** `docs.resolve` replaced the OpenContext resolver; the chip keeps its own shape. */
export const FT3_DOCS_RESOLVE = "docs.resolve" as const;

export const docsEnvironment = {
  resolveDoc: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:docs:resolve",
    tag: FT3_DOCS_RESOLVE,
    staleTimeMs: 15_000,
  }),
};

export type DocsResolveQueryResult = EnvironmentRpcSuccess<typeof FT3_DOCS_RESOLVE>;

/** Maps the store's `docs.resolve` result onto the chip's document shape. */
export function toOpenContextDocResolveResult(
  value: DocsResolveQueryResult,
): OpenContextDocResolveResult {
  switch (value.status) {
    case "found":
      return {
        status: "found",
        stableId: value.stableId,
        name: value.name,
        relativePath: value.relPath,
        absolutePath: value.absolutePath,
      };
    case "not_found":
      return { status: "not_found" };
    case "unavailable":
      return { status: "store_unavailable" };
  }
}
