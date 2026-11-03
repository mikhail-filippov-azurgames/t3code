import { FT3_POLICIES_WS_METHODS as WS_METHODS } from "@t3tools/ft3-policies/rpc-contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export function createPoliciesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:policies:snapshot",
      tag: WS_METHODS.policiesGetSnapshot,
      staleTimeMs: 0,
    }),
    readDocument: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:policies:read-document",
      tag: WS_METHODS.policiesReadDocument,
      staleTimeMs: 0,
    }),
    saveDocument: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:policies:save-document",
      tag: WS_METHODS.policiesSaveDocument,
    }),
    pendingChange: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:policies:pending-change",
      tag: WS_METHODS.policiesGetPendingChange,
      staleTimeMs: 0,
    }),
    applyPending: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:policies:apply-pending",
      tag: WS_METHODS.policiesApplyPending,
    }),
    setApplyExternalEdits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:policies:set-apply-external-edits",
      tag: WS_METHODS.policiesSetApplyExternalEdits,
    }),
  };
}
