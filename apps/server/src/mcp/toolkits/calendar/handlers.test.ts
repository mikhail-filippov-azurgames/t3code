import {
  type CalendarEvent,
  CalendarEventId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CalendarUpdateInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import * as CalendarEvents from "../../../persistence/Services/CalendarEvents.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CalendarToolkitHandlersLive } from "./handlers.ts";
import { CalendarToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const HOURLY_UTC = "0 * * * *";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: CalendarEventId.make("event-1"),
    projectId: PROJECT_ID,
    title: "Standup",
    message: "Run the standup",
    mode: "new-thread",
    cronExpression: HOURLY_UTC,
    timeZone: "UTC",
    nextFireAt: "2026-01-15T14:00:00.000Z",
    lastFiredAt: null,
    lastMissedAt: null,
    threadId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const updateInput = (overrides: Partial<CalendarUpdateInput> = {}): CalendarUpdateInput => ({
  eventId: CalendarEventId.make("event-1"),
  title: "Renamed",
  message: "New body",
  mode: "new-thread",
  cronExpression: HOURLY_UTC,
  timeZone: "UTC",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...overrides,
});

const makeHarness = Effect.fn("makeCalendarToolkitHarness")(function* (
  seeds: ReadonlyArray<CalendarEvent> = [],
) {
  const events = yield* Ref.make<ReadonlyArray<CalendarEvent>>(seeds);
  const created = yield* Ref.make<ReadonlyArray<CalendarEvent>>([]);
  const updated = yield* Ref.make<ReadonlyArray<CalendarEvent>>([]);
  const deleted = yield* Ref.make<ReadonlyArray<string>>([]);

  const dependencies = Layer.mergeAll(
    Layer.mock(CalendarEvents.CalendarEventRepository)({
      create: (event) =>
        Ref.update(events, (rows) => [...rows, event]).pipe(
          Effect.andThen(Ref.update(created, (rows) => [...rows, event])),
        ),
      update: (event) =>
        Ref.update(updated, (rows) => [...rows, event]).pipe(
          Effect.andThen(
            Ref.update(events, (rows) =>
              rows.map((row) => (row.eventId === event.eventId ? event : row)),
            ),
          ),
        ),
      getById: ({ eventId }) =>
        Ref.get(events).pipe(
          Effect.map((rows) => Option.fromNullishOr(rows.find((row) => row.eventId === eventId))),
        ),
      listAll: () => Ref.get(events),
      deleteById: ({ eventId }) =>
        Ref.update(deleted, (rows) => [...rows, eventId]).pipe(
          Effect.andThen(
            Ref.update(events, (rows) => rows.filter((row) => row.eventId !== eventId)),
          ),
        ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  const toolkit = yield* CalendarToolkit.pipe(
    Effect.provide(CalendarToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );

  const call = <Name extends keyof typeof CalendarToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof CalendarToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );

  return { events, created, updated, deleted, call };
});

describe("calendar toolkit handlers", () => {
  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("calendar_list", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "orchestration",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.created)).toEqual([]);
      expect(yield* Ref.get(harness.events)).toEqual([]);
    }),
  );

  it.effect("creates an event through the same scheduling path as calendar.create", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeHarness();
      const result = yield* harness.call("calendar_create", {
        projectId: PROJECT_ID,
        title: "Daily standup",
        message: "Summarize yesterday and plan today.",
        mode: "new-thread",
        cronExpression: "0 16 * * 1-5",
        timeZone: "America/New_York",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      });

      // 16:00 New York wall clock in January is 21:00Z; the RPC computes the
      // same nextFireAt from the same fields.
      expect(result.nextFireAt).toBe("2026-01-15T21:00:00.000Z");
      expect(result.createdAt).toBe("2026-01-15T13:30:00.000Z");
      expect(result.updatedAt).toBe("2026-01-15T13:30:00.000Z");
      expect(result.lastFiredAt).toBeNull();
      expect(result.threadId).toBeNull();
      expect(result.eventId).toBeTruthy();

      const created = yield* Ref.get(harness.created);
      expect(created).toEqual([result]);
    }),
  );

  it.effect("applies the contract defaults for runtime and interaction mode", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeHarness();
      const result = yield* harness.call("calendar_create", {
        projectId: PROJECT_ID,
        title: "Daily standup",
        message: "Summarize yesterday and plan today.",
        mode: "continue",
        cronExpression: HOURLY_UTC,
        timeZone: "UTC",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      });
      expect(result.runtimeMode).toBe("full-access");
      expect(result.interactionMode).toBe("default");
      expect(result.mode).toBe("continue");
    }),
  );

  it.effect("surfaces a schedule with no upcoming fire time as a tool error", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("calendar_create", {
          projectId: PROJECT_ID,
          title: "Impossible",
          message: "Never fires",
          mode: "new-thread",
          cronExpression: "0 0 31 2 *",
          timeZone: "UTC",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CalendarError",
        operation: "calendar.create",
        detail: "Cron expression has no upcoming fire time.",
      });
      expect(yield* Ref.get(harness.created)).toEqual([]);
    }),
  );

  it.effect("refuses a minute new-thread schedule on create but allows continue", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("calendar_create", {
          projectId: PROJECT_ID,
          title: "Every minute",
          message: "Too dense for new-thread",
          mode: "new-thread",
          cronExpression: "* * * * *",
          timeZone: "UTC",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CalendarError", operation: "calendar.create" });
      if (error._tag === "CalendarError") {
        expect(error.detail).toContain("new-thread");
        expect(error.detail).toContain("continue");
      }
      expect(yield* Ref.get(harness.created)).toEqual([]);

      const accepted = yield* harness.call("calendar_create", {
        projectId: PROJECT_ID,
        title: "Every minute",
        message: "Continue mode is fine",
        mode: "continue",
        cronExpression: "* * * * *",
        timeZone: "UTC",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      });
      expect(accepted.mode).toBe("continue");
      expect(accepted.warning).toBeUndefined();
    }),
  );

  it.effect("warns when a new-thread schedule fires more than once an hour", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("calendar_create", {
        projectId: PROJECT_ID,
        title: "Twice hourly",
        message: "Still allowed",
        mode: "new-thread",
        cronExpression: "0,30 9-16 * * *",
        timeZone: "UTC",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      });
      expect(result.warning).toContain("one real thread on every fire");
      expect(yield* Ref.get(harness.created)).toHaveLength(1);
    }),
  );

  it.effect("refuses changing an event to a minute new-thread schedule on update", () =>
    Effect.gen(function* () {
      const existing = makeCalendarEvent({ mode: "continue", threadId: ThreadId.make("thread-1") });
      const harness = yield* makeHarness([existing]);
      const error = yield* harness
        .call("calendar_update", updateInput({ mode: "new-thread", cronExpression: "* * * * *" }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CalendarError", operation: "calendar.update" });
      expect(yield* Ref.get(harness.updated)).toEqual([]);
    }),
  );

  it.effect("grandfathers a text-only update of a stored violating event", () =>
    Effect.gen(function* () {
      const existing = makeCalendarEvent({
        mode: "new-thread",
        cronExpression: "* * * * *",
      });
      const harness = yield* makeHarness([existing]);
      const result = yield* harness.call(
        "calendar_update",
        updateInput({ mode: "new-thread", cronExpression: "* * * * *" }),
      );
      expect(result.title).toBe("Renamed");
      expect(result.warning).toBeUndefined();
      expect(yield* Ref.get(harness.updated)).toHaveLength(1);
    }),
  );

  it.effect("rejects malformed arguments before reaching the calendar store", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("calendar_create", { projectId: PROJECT_ID } as never)
        .pipe(Effect.flip);
      expect(error).toMatchObject({ reason: { _tag: "ToolParameterValidationError" } });
      expect(yield* Ref.get(harness.created)).toEqual([]);
    }),
  );

  it.effect("lists the events already stored", () =>
    Effect.gen(function* () {
      const event = makeCalendarEvent();
      const harness = yield* makeHarness([event]);
      const result = yield* harness.call("calendar_list", {});
      expect(result.events).toEqual([event]);
    }),
  );

  it.effect("recomputes nextFireAt on update and keeps the run history", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const existing = makeCalendarEvent({
        mode: "continue",
        threadId: ThreadId.make("thread-1"),
        lastFiredAt: "2026-01-15T13:00:00.000Z",
      });
      const harness = yield* makeHarness([existing]);
      const result = yield* harness.call(
        "calendar_update",
        updateInput({ cronExpression: "0 16 * * *" }),
      );
      expect(result.nextFireAt).toBe("2026-01-15T16:00:00.000Z");
      expect(result.updatedAt).toBe("2026-01-15T13:30:00.000Z");
      expect(result.title).toBe("Renamed");
      expect(result.threadId).toBe(ThreadId.make("thread-1"));
      expect(result.lastFiredAt).toBe("2026-01-15T13:00:00.000Z");
      expect(yield* Ref.get(harness.updated)).toEqual([result]);
    }),
  );

  it.effect("reports an update of a missing event as a tool error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("calendar_update", updateInput({ eventId: CalendarEventId.make("missing") }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CalendarError",
        operation: "calendar.update",
        detail: "Calendar event not found.",
      });
    }),
  );

  it.effect("deletes an event and removes it from the store", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([makeCalendarEvent()]);
      const result = yield* harness.call("calendar_delete", {
        eventId: CalendarEventId.make("event-1"),
      });
      expect(result).toEqual({});
      expect(yield* Ref.get(harness.deleted)).toEqual([CalendarEventId.make("event-1")]);
      expect(yield* Ref.get(harness.events)).toEqual([]);
    }),
  );
});
