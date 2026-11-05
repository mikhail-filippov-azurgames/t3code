import { FT3_MAIL_WS_METHODS as WS_METHODS } from "@t3tools/ft3-mail/rpc-contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export function createMailEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const tasks = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:mail:tasks",
    tag: WS_METHODS.mailTasks,
    staleTimeMs: 15_000,
  });
  return { tasks };
}
