import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * OpenContext resolution is a server-side filesystem read, so it goes through
 * the environment RPC like any other project read. The family caches per
 * environment and stable id, and a short stale window lets a link retry once
 * the store changes without hammering the resolver.
 */
export const openContextEnvironment = {
  resolveDoc: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:opencontext:resolve-doc",
    tag: WS_METHODS.openContextResolveDoc,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  }),
};
