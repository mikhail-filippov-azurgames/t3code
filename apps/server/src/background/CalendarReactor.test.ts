import {
  CALENDAR_CRON_LOOKAHEAD_DAYS,
  calendarCronMatchesDay,
  type CalendarEvent,
  CalendarEventId,
  type CalendarUpdateInput,
  type HostPowerSnapshot,
  type OrchestrationCommand,
  parseCalendarCron,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import {
  CalendarEventRepository,
  type RecordCalendarFireInput,
  type RecordCalendarMissInput,
} from "../persistence/Services/CalendarEvents.ts";
import {
  FIRE_PER_SWEEP_LIMIT,
  make as makeCalendarReactor,
  nextCalendarFireAt,
  planCalendarEventUpdate,
} from "./CalendarReactor.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

describe("parseCalendarCron", () => {
  it("rejects an expression that is not five fields", () => {
    assert.equal(parseCalendarCron("0 9 * *"), null);
    assert.equal(parseCalendarCron(""), null);
  });

  it("rejects an out-of-range or malformed value", () => {
    assert.equal(parseCalendarCron("99 9 * * *"), null);
    assert.equal(parseCalendarCron("0 9 * * 8"), null);
    assert.equal(parseCalendarCron("0 9 0 * *"), null);
  });

  it("normalises both Sunday values to 0", () => {
    const parsed = parseCalendarCron("0 16 * * 7");
    assert.ok(parsed !== null);
    assert.deepEqual([...parsed.dayOfWeek.values], [0]);
    assert.equal(parsed.dayOfWeek.restricted, true);
  });

  it("reads a bare n/step as n through the field maximum", () => {
    const parsed = parseCalendarCron("5/10 9 * * *");
    assert.ok(parsed !== null);
    assert.deepEqual([...parsed.minute.values], [5, 15, 25, 35, 45, 55]);
  });

  it("accepts a stepped wildcard and a stepped range", () => {
    const parsed = parseCalendarCron("*/15 9-17 * * *");
    assert.ok(parsed !== null);
    assert.deepEqual([...parsed.minute.values], [0, 15, 30, 45]);
    assert.deepEqual([...parsed.hour.values], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("ORs a restricted day-of-month and day-of-week", () => {
    const parsed = parseCalendarCron("0 9 1 * 1");
    assert.ok(parsed !== null);
    // 2026-01-05 is a Monday that is not the 1st.
    assert.equal(calendarCronMatchesDay(parsed, 5, 1), true);
    // 2026-01-01 is the 1st but a Thursday.
    assert.equal(calendarCronMatchesDay(parsed, 1, 4), true);
    assert.equal(calendarCronMatchesDay(parsed, 2, 5), false);
  });

  it("looks ahead eight years of calendar days", () => {
    assert.equal(CALENDAR_CRON_LOOKAHEAD_DAYS, 366 * 8);
  });
});

describe("nextCalendarFireAt DST", () => {
  it("resolves an ambiguous fall-back slot to the earlier instant", () => {
    assert.equal(
      nextCalendarFireAt("30 1 1 11 *", "America/New_York", "2026-10-15T12:00:00.000Z"),
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("skips a spring-forward gap slot and fires the next year instead", () => {
    assert.equal(
      nextCalendarFireAt("30 2 8 3 *", "America/New_York", "2026-01-15T00:00:00.000Z"),
      "2027-03-08T07:30:00.000Z",
    );
  });

  it("skips the gap slot but still fires at a valid later slot the same day", () => {
    assert.equal(
      nextCalendarFireAt("30 2-3 8 3 *", "America/New_York", "2026-01-15T00:00:00.000Z"),
      "2026-03-08T07:30:00.000Z",
    );
  });
});

const HOURLY_UTC = "0 * * * *";

describe("planCalendarEventUpdate", () => {
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

  it("keeps the schedule on a text-only edit and preserves the run history", () => {
    const current: CalendarEvent = {
      ...makeCalendarEvent({
        nextFireAt: "2026-01-15T14:00:00.000Z",
        mode: "continue",
        threadId: ThreadId.make("thread-1"),
      }),
      lastFiredAt: "2026-01-15T13:00:00.000Z",
      lastMissedAt: "2026-01-15T12:00:00.000Z",
    };
    const updated = planCalendarEventUpdate(current, updateInput(), "2026-01-15T13:30:00.000Z");
    assert.ok(updated !== null);
    assert.equal(updated.nextFireAt, "2026-01-15T14:00:00.000Z");
    assert.equal(updated.title, "Renamed");
    assert.equal(updated.message, "New body");
    assert.equal(updated.threadId, ThreadId.make("thread-1"));
    assert.equal(updated.lastFiredAt, "2026-01-15T13:00:00.000Z");
    assert.equal(updated.lastMissedAt, "2026-01-15T12:00:00.000Z");
    assert.equal(updated.createdAt, current.createdAt);
    assert.equal(updated.updatedAt, "2026-01-15T13:30:00.000Z");
  });

  it("recomputes the next fire from now when the cron changes", () => {
    const current = makeCalendarEvent({ nextFireAt: "2026-01-15T14:00:00.000Z" });
    const updated = planCalendarEventUpdate(
      current,
      updateInput({ cronExpression: "0 16 * * *" }),
      "2026-01-15T13:30:00.000Z",
    );
    assert.ok(updated !== null);
    assert.equal(updated.nextFireAt, "2026-01-15T16:00:00.000Z");
  });

  it("recomputes when only the time zone changes", () => {
    const current = makeCalendarEvent({
      nextFireAt: "2026-01-15T16:00:00.000Z",
      cronExpression: "0 16 * * *",
    });
    const updated = planCalendarEventUpdate(
      current,
      updateInput({ cronExpression: "0 16 * * *", timeZone: "America/New_York" }),
      "2026-01-15T13:30:00.000Z",
    );
    assert.ok(updated !== null);
    // 16:00 New York wall clock in January is 21:00Z.
    assert.equal(updated.nextFireAt, "2026-01-15T21:00:00.000Z");
  });

  it("returns null when a changed schedule has no upcoming slot", () => {
    const current = makeCalendarEvent({ nextFireAt: "2026-01-15T14:00:00.000Z" });
    const updated = planCalendarEventUpdate(
      current,
      updateInput({ cronExpression: "0 0 31 2 *" }),
      "2026-01-15T13:30:00.000Z",
    );
    assert.equal(updated, null);
  });
});

const nominalHostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: DateTime.makeUnsafe("2026-01-15T00:00:00.000Z"),
};

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeCalendarEvent(options: {
  readonly nextFireAt: string;
  readonly threadId?: ThreadId | null;
  readonly mode?: "new-thread" | "continue";
  readonly eventId?: string;
  readonly cronExpression?: string;
}): CalendarEvent {
  return {
    eventId: CalendarEventId.make(options.eventId ?? "event-1"),
    projectId: ProjectId.make("project-1"),
    title: "Standup",
    message: "Run the standup",
    mode: options.mode ?? "new-thread",
    cronExpression: options.cronExpression ?? HOURLY_UTC,
    timeZone: "UTC",
    nextFireAt: options.nextFireAt,
    lastFiredAt: null,
    lastMissedAt: null,
    threadId: options.threadId ?? null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Boot the reactor against recording fakes; the caller inspects the Refs. */
function makeStartupHarness(...seeds: ReadonlyArray<CalendarEvent>) {
  return Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<CalendarEvent>>(seeds);
    const missed = yield* Ref.make<ReadonlyArray<RecordCalendarMissInput>>([]);
    const fired = yield* Ref.make<ReadonlyArray<RecordCalendarFireInput>>([]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const listDueCount = yield* Ref.make(0);
    const sweepRan = yield* Deferred.make<void>();

    const repository = Layer.mock(CalendarEventRepository)({
      listAll: () => Ref.get(events),
      listDue: ({ nowIso, limit }) =>
        Ref.update(listDueCount, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(sweepRan, undefined).pipe(Effect.asVoid)),
          Effect.andThen(
            Ref.get(events).pipe(
              Effect.map((rows) => rows.filter((row) => row.nextFireAt <= nowIso).slice(0, limit)),
            ),
          ),
        ),
      recordMissed: (input) =>
        Ref.update(missed, (all) => [...all, input]).pipe(
          Effect.andThen(
            Ref.update(events, (rows) =>
              rows.map((row) =>
                row.eventId === input.eventId
                  ? {
                      ...row,
                      nextFireAt: input.nextFireAt,
                      lastMissedAt: input.missedAt,
                      updatedAt: input.updatedAt,
                    }
                  : row,
              ),
            ),
          ),
        ),
      recordFire: (input) =>
        Ref.update(fired, (all) => [...all, input]).pipe(
          Effect.andThen(
            Ref.update(events, (rows) =>
              rows.map((row) =>
                row.eventId === input.eventId
                  ? {
                      ...row,
                      nextFireAt: input.nextFireAt,
                      lastFiredAt: input.firedAt,
                      updatedAt: input.updatedAt,
                    }
                  : row,
              ),
            ),
          ),
        ),
    });

    const engine = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
    });

    const hostPower = Layer.succeed(
      HostPowerMonitor.HostPowerMonitor,
      HostPowerMonitor.HostPowerMonitor.of({
        snapshot: Effect.succeed(nominalHostPower),
        report: () => Effect.void,
        streamChanges: Stream.empty,
      }),
    );

    const deps = Layer.mergeAll(
      repository,
      engine,
      hostPower,
      Layer.succeed(Crypto.Crypto, testCrypto),
    );
    const reactor = yield* makeCalendarReactor.pipe(Effect.provide(deps));
    return { events, missed, fired, commands, listDueCount, sweepRan, reactor };
  });
}

const countCommands = (commands: ReadonlyArray<OrchestrationCommand>, type: string): number =>
  commands.filter((command) => command.type === type).length;

describe("CalendarReactor startup miss semantics", () => {
  it.effect("a due slot at boot records one miss and advances without firing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();

      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.missedAt, "2026-01-15T13:00:00.000Z");
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T14:00:00.000Z");
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
    }),
  );

  it.effect("several missed hourly slots collapse to one miss with no catch-up", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T08:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();

      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.missedAt, "2026-01-15T08:00:00.000Z");
      // Schedule jumps from now to the next future slot, skipping 09:00-13:00.
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T14:00:00.000Z");
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 0);
      assert.equal(countCommands(commands, "thread.message.system.append"), 1);
    }),
  );

  it.effect("a restart exactly at the slot instant treats the slot as missed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();

      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.missedAt, "2026-01-15T14:00:00.000Z");
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T15:00:00.000Z");
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
    }),
  );

  it.effect("the sweep after a boot miss does not fire the skipped slot", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();
      assert.equal((yield* Ref.get(harness.fired)).length, 0);

      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(harness.sweepRan);

      assert.equal(yield* Ref.get(harness.listDueCount), 1);
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 0);
    }),
  );

  it.effect("a missed continue event notifies its thread with a skipped notice", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const threadId = ThreadId.make("thread-1");
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId,
        }),
      );
      yield* harness.reactor.start();

      const commands = yield* Ref.get(harness.commands);
      assert.equal(commands.length, 1);
      const notice = commands[0];
      assert.isTrue(notice !== undefined && notice.type === "thread.message.system.append");
      if (notice?.type === "thread.message.system.append") {
        assert.equal(notice.threadId, threadId);
        assert.include(
          notice.message.text,
          "Scheduled run skipped (missed at 2026-01-15T13:00:00.000Z)",
        );
      }
    }),
  );

  it.effect("a missed new-thread event warns and dispatches no notice", () => {
    const logs: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      logs.push(Array.isArray(message) ? message.join(" ") : message);
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "new-thread",
          threadId: null,
        }),
      );
      yield* harness.reactor.start();

      assert.equal((yield* Ref.get(harness.missed)).length, 1);
      assert.equal((yield* Ref.get(harness.commands)).length, 0);
      assert.isTrue(
        logs.some(
          (message) =>
            typeof message === "string" && message.includes("missed before a thread existed"),
        ),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});

describe("CalendarReactor sweep fire cap", () => {
  /** Seed future rows (startup is a no-op), then backdate them after boot. */
  const backdate = (
    events: Ref.Ref<ReadonlyArray<CalendarEvent>>,
    nextFireAtByEventId: ReadonlyMap<string, string>,
  ) =>
    Ref.update(events, (rows) =>
      rows.map((row) => ({
        ...row,
        nextFireAt: nextFireAtByEventId.get(row.eventId) ?? row.nextFireAt,
      })),
    );

  it.effect("caps fires per sweep and finishes the backlog on the next sweep", () =>
    Effect.gen(function* () {
      assert.equal(FIRE_PER_SWEEP_LIMIT, 3);
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({ nextFireAt: "2026-01-15T08:00:00.000Z" }),
      );
      yield* harness.reactor.start();
      yield* backdate(harness.events, new Map([["event-1", "2026-01-15T03:00:00.000Z"]]));

      yield* TestClock.adjust("30 seconds");
      const firstFires = yield* Ref.get(harness.fired);
      assert.equal(firstFires.length, FIRE_PER_SWEEP_LIMIT);
      assert.deepEqual(
        firstFires.map((fire) => fire.nextFireAt),
        ["2026-01-15T04:00:00.000Z", "2026-01-15T05:00:00.000Z", "2026-01-15T06:00:00.000Z"],
      );

      yield* TestClock.adjust("30 seconds");
      const allFires = yield* Ref.get(harness.fired);
      assert.equal(allFires.length, 5);
      assert.deepEqual(
        allFires.map((fire) => fire.nextFireAt),
        [
          "2026-01-15T04:00:00.000Z",
          "2026-01-15T05:00:00.000Z",
          "2026-01-15T06:00:00.000Z",
          "2026-01-15T07:00:00.000Z",
          "2026-01-15T08:00:00.000Z",
        ],
      );
      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 5);
      const turnMessageIds = commands
        .filter((command) => command.type === "thread.turn.start")
        .map((command) => (command.type === "thread.turn.start" ? command.message.messageId : ""));
      assert.equal(new Set(turnMessageIds).size, 5);
    }),
  );

  it.effect("a single due event still fires exactly once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({ nextFireAt: "2026-01-15T08:00:00.000Z" }),
      );
      yield* harness.reactor.start();
      yield* backdate(harness.events, new Map([["event-1", "2026-01-15T07:00:00.000Z"]]));

      yield* TestClock.adjust("30 seconds");
      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T08:00:00.000Z");

      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Ref.get(harness.fired)).length, 1);
    }),
  );

  it.effect("a due event past the cap keeps its schedule until its turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          eventId: "event-1",
          nextFireAt: "2026-01-16T03:00:00.000Z",
          cronExpression: "0 3 * * *",
        }),
        makeCalendarEvent({
          eventId: "event-2",
          nextFireAt: "2026-01-16T04:00:00.000Z",
          cronExpression: "0 4 * * *",
        }),
        makeCalendarEvent({
          eventId: "event-3",
          nextFireAt: "2026-01-16T05:00:00.000Z",
          cronExpression: "0 5 * * *",
        }),
        makeCalendarEvent({
          eventId: "event-4",
          nextFireAt: "2026-01-16T06:00:00.000Z",
          cronExpression: "0 6 * * *",
        }),
      );
      yield* harness.reactor.start();
      yield* backdate(
        harness.events,
        new Map([
          ["event-1", "2026-01-15T03:00:00.000Z"],
          ["event-2", "2026-01-15T04:00:00.000Z"],
          ["event-3", "2026-01-15T05:00:00.000Z"],
          ["event-4", "2026-01-15T06:00:00.000Z"],
        ]),
      );

      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(
        (yield* Ref.get(harness.fired)).map((fire) => fire.eventId),
        ["event-1", "event-2", "event-3"],
      );
      const afterFirst = yield* Ref.get(harness.events);
      assert.equal(
        afterFirst.find((row) => row.eventId === "event-4")?.nextFireAt,
        "2026-01-15T06:00:00.000Z",
      );

      yield* TestClock.adjust("30 seconds");
      const finalFires = yield* Ref.get(harness.fired);
      assert.equal(finalFires.length, 4);
      assert.equal(finalFires[3]?.eventId, "event-4");
    }),
  );

  it.effect("orders due events by slot, then by event id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          eventId: "event-z",
          nextFireAt: "2026-01-16T05:00:00.000Z",
          cronExpression: "0 5 * * *",
        }),
        makeCalendarEvent({
          eventId: "event-b",
          nextFireAt: "2026-01-16T04:00:00.000Z",
          cronExpression: "0 4 * * *",
        }),
        makeCalendarEvent({
          eventId: "event-a",
          nextFireAt: "2026-01-16T04:00:00.000Z",
          cronExpression: "0 4 * * *",
        }),
      );
      yield* harness.reactor.start();
      yield* backdate(
        harness.events,
        new Map([
          ["event-z", "2026-01-15T05:00:00.000Z"],
          ["event-b", "2026-01-15T04:00:00.000Z"],
          ["event-a", "2026-01-15T04:00:00.000Z"],
        ]),
      );

      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(
        (yield* Ref.get(harness.fired)).map((fire) => fire.eventId),
        ["event-a", "event-b", "event-z"],
      );
    }),
  );
});
