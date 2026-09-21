import { describe, expect, it } from "@effect/vitest";
import {
  CalendarEventId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  type CalendarCreateInput,
  type CalendarEvent,
  type CalendarUpdateInput,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createCalendarEnvironmentAtoms } from "./calendar.ts";
import { runAtomCommand } from "./runtime.ts";

const environmentId = EnvironmentId.make("environment-1");

const createInput: CalendarCreateInput = {
  projectId: ProjectId.make("project-1"),
  title: "Daily review",
  message: "Summarise the day.",
  mode: "new-thread",
  cronExpression: "0 9 * * *",
  timeZone: "UTC",
  modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
  runtimeMode: "full-access",
  interactionMode: "default",
};

const updateInput: CalendarUpdateInput = {
  eventId: CalendarEventId.make("event-1"),
  title: "Daily review",
  message: "Summarise the day.",
  mode: "new-thread",
  cronExpression: "0 9 * * *",
  timeZone: "UTC",
  modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
  runtimeMode: "full-access",
  interactionMode: "default",
};

function makeEvent(eventId: string): CalendarEvent {
  const now = "2026-01-05T08:00:00.000Z";
  return {
    eventId: CalendarEventId.make(eventId),
    projectId: ProjectId.make("project-1"),
    title: "Daily review",
    message: "Summarise the day.",
    mode: "new-thread",
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    nextFireAt: now,
    lastFiredAt: null,
    lastMissedAt: null,
    threadId: null,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    updatedAt: now,
  };
}

/** A connected environment whose calendar RPCs are recorded, with one in-memory event list. */
const makeHarness = Effect.fn("calendarTest.makeHarness")(function* () {
  const calls: string[] = [];
  const events: CalendarEvent[] = [];
  const client = {
    [WS_METHODS.calendarList]: () => {
      calls.push(WS_METHODS.calendarList);
      return Effect.succeed({ events: [...events] });
    },
    [WS_METHODS.calendarCreate]: () => {
      calls.push(WS_METHODS.calendarCreate);
      const event = makeEvent("event-created");
      events.push(event);
      return Effect.succeed(event);
    },
    [WS_METHODS.calendarUpdate]: () => {
      calls.push(WS_METHODS.calendarUpdate);
      const event = makeEvent("event-updated");
      events.push(event);
      return Effect.succeed(event);
    },
    [WS_METHODS.calendarDelete]: () => {
      calls.push(WS_METHODS.calendarDelete);
      return Effect.succeed({});
    },
  } as unknown as WsRpcProtocolClient;
  const session = { client } as RpcSession;
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "local",
      httpBaseUrl: "https://environment.test",
      wsBaseUrl: "wss://environment.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createCalendarEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
  );
  return { atoms, calls, registry };
});

describe("createCalendarEnvironmentAtoms", () => {
  it.effect("create persists on the server and refreshes the list", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const listAtom = atoms.list({ environmentId, input: {} });

      const initial = yield* AtomRegistry.getResult(registry, listAtom, {
        suspendOnWaiting: true,
      });
      expect(initial.events).toEqual([]);

      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          atoms.create,
          { environmentId, input: createInput },
          { reportFailure: false },
        ),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(AsyncResult.isSuccess(result) ? (result.value.eventId as string) : null).toBe(
        "event-created",
      );
      expect(calls).toContain(WS_METHODS.calendarCreate);

      const refreshed = yield* AtomRegistry.getResult(registry, listAtom, {
        suspendOnWaiting: true,
      });
      expect(refreshed.events.map((event) => event.eventId as string)).toEqual(["event-created"]);
      expect(calls.filter((call) => call === WS_METHODS.calendarList)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("update persists on the server and refreshes the list", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const listAtom = atoms.list({ environmentId, input: {} });

      yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });

      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          atoms.update,
          { environmentId, input: updateInput },
          { reportFailure: false },
        ),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(AsyncResult.isSuccess(result) ? (result.value.eventId as string) : null).toBe(
        "event-updated",
      );
      expect(calls).toContain(WS_METHODS.calendarUpdate);

      const refreshed = yield* AtomRegistry.getResult(registry, listAtom, {
        suspendOnWaiting: true,
      });
      expect(refreshed.events.map((event) => event.eventId as string)).toEqual(["event-updated"]);
      expect(calls.filter((call) => call === WS_METHODS.calendarList)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("delete removes on the server and refreshes the list", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const listAtom = atoms.list({ environmentId, input: {} });

      yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });

      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          atoms.delete,
          { environmentId, input: { eventId: CalendarEventId.make("event-1") } },
          { reportFailure: false },
        ),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(calls).toContain(WS_METHODS.calendarDelete);

      yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
      expect(calls.filter((call) => call === WS_METHODS.calendarList)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});
