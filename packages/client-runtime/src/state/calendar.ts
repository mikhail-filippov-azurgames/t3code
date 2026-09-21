/**
 * Calendar event reads and writes for one environment.
 *
 * The server is the only source of events: `calendar.list` answers with the
 * environment's events, and a successful `create`, `update`, or `delete`
 * refreshes that read so readers never merge a local write against a stale
 * list.
 *
 * @module state/calendar
 */
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createCalendarEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:calendar:list",
    tag: WS_METHODS.calendarList,
    staleTimeMs: 30_000,
  });
  const refreshList = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));

  return {
    list,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:create",
      tag: WS_METHODS.calendarCreate,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: refreshList,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:update",
      tag: WS_METHODS.calendarUpdate,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: refreshList,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:delete",
      tag: WS_METHODS.calendarDelete,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: refreshList,
    }),
  };
}
