import {
  CALENDAR_CRON_LOOKAHEAD_DAYS,
  calendarCronMatchesDay,
  type CalendarEvent,
  CalendarEventId,
  type CalendarRunNotice,
  calendarRunNoticeKey,
  type CalendarUpdateInput,
  type HostPowerSnapshot,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  parseCalendarCron,
  ProjectId,
  ProviderDriverKind,
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
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { ORCHESTRATION_COMMAND_NO_EVENTS_DETAIL } from "../orchestration/Layers/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstanceRoutingInfo } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import {
  CalendarEventRepository,
  type RecordCalendarFireInput,
  type RecordCalendarMissInput,
} from "../persistence/Services/CalendarEvents.ts";
import { CalendarNotices } from "./CalendarNotices.ts";
import {
  assessCalendarEventUpdateCadence,
  assessCalendarNewThreadCadence,
  CALENDAR_FIRE_GRACE_MS,
  CALENDAR_NEW_THREAD_MIN_INTERVAL_MS,
  CALENDAR_NEW_THREAD_WARN_INTERVAL_MS,
  calendarMinFireIntervalMs,
  FIRE_PER_SWEEP_LIMIT,
  formatCalendarRunMessage,
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

describe("calendar new-thread cadence", () => {
  const FROM = "2026-01-15T13:30:00.000Z";

  it("pins the floor at fifteen minutes and the warning at one hour", () => {
    assert.equal(CALENDAR_NEW_THREAD_MIN_INTERVAL_MS, 15 * 60 * 1000);
    assert.equal(CALENDAR_NEW_THREAD_WARN_INTERVAL_MS, 60 * 60 * 1000);
  });

  it("measures the smallest gap between consecutive fires", () => {
    // Fires at :00 and :14 within each hour, so the smallest gap is 14 minutes.
    assert.equal(calendarMinFireIntervalMs("0,14 9-16 * * *", "UTC", FROM), 14 * 60_000);
  });

  it("refuses a new-thread minute schedule but allows continue", () => {
    const forbidden = assessCalendarNewThreadCadence("new-thread", "* * * * *", "UTC", FROM);
    assert.ok(forbidden.forbiddenDetail !== null);
    assert.ok(forbidden.forbiddenDetail.includes("new-thread"));
    assert.ok(forbidden.forbiddenDetail.includes("continue"));
    assert.equal(forbidden.warning, null);
    assert.deepEqual(assessCalendarNewThreadCadence("continue", "* * * * *", "UTC", FROM), {
      forbiddenDetail: null,
      warning: null,
    });
  });

  it("refuses just under the floor and accepts just over", () => {
    // Smallest gap 14 minutes: below the floor.
    assert.ok(
      assessCalendarNewThreadCadence("new-thread", "0,14 9-16 * * *", "UTC", FROM)
        .forbiddenDetail !== null,
    );
    // Smallest gap 16 minutes: accepted with the sub-hour warning.
    const accepted = assessCalendarNewThreadCadence("new-thread", "0,16 9-16 * * *", "UTC", FROM);
    assert.equal(accepted.forbiddenDetail, null);
    assert.ok(accepted.warning !== null);
  });

  it("warns below one hour and stays silent at hourly or rarer", () => {
    const warned = assessCalendarNewThreadCadence("new-thread", "0,30 9-16 * * *", "UTC", FROM);
    assert.ok(warned.warning !== null);
    assert.ok(warned.warning.includes("one real thread on every fire"));
    assert.deepEqual(assessCalendarNewThreadCadence("new-thread", "0 9 * * *", "UTC", FROM), {
      forbiddenDetail: null,
      warning: null,
    });
  });

  it("grandfathers a text-only edit but re-validates a changed schedule", () => {
    const current = makeCalendarEvent({
      nextFireAt: "2026-01-15T14:00:00.000Z",
      mode: "new-thread",
      cronExpression: "* * * * *",
    });
    const keepSchedule: CalendarUpdateInput = {
      eventId: current.eventId,
      title: "Renamed",
      message: "New body",
      mode: current.mode,
      cronExpression: current.cronExpression,
      timeZone: current.timeZone,
      modelSelection: current.modelSelection,
      runtimeMode: current.runtimeMode,
      interactionMode: current.interactionMode,
    };
    assert.deepEqual(assessCalendarEventUpdateCadence(current, keepSchedule, FROM), {
      forbiddenDetail: null,
      warning: null,
    });

    const slower = assessCalendarEventUpdateCadence(
      current,
      { ...keepSchedule, mode: "continue" },
      FROM,
    );
    assert.deepEqual(slower, { forbiddenDetail: null, warning: null });
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
  readonly modelSelection?: ModelSelection;
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
    modelSelection: options.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeShell(
  threadId: ThreadId,
  overrides: {
    readonly modelSelection?: ModelSelection;
    readonly session?: OrchestrationSession | null;
  } = {},
): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: overrides.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: overrides.session ?? null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeBusySession(threadId: ThreadId): OrchestrationSession {
  return {
    threadId,
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-01-15T07:00:00.000Z",
  };
}

function makeInstanceInfo(
  instanceId: ProviderInstanceId,
  driver: string,
  continuationKey?: string,
): ProviderInstanceRoutingInfo {
  const driverKind = ProviderDriverKind.make(driver);
  return {
    instanceId,
    driverKind,
    displayName: undefined,
    enabled: true,
    continuationIdentity: {
      driverKind,
      continuationKey: continuationKey ?? `test:${String(instanceId)}`,
    },
  };
}

type ShellOverride = { readonly missing: true } | { readonly shell: OrchestrationThreadShell };
type InstanceOverride =
  | { readonly unknown: true }
  | { readonly transient: true }
  | { readonly info: ProviderInstanceRoutingInfo };

/** Boot the reactor against recording fakes; the caller inspects the Refs. */
function makeStartupHarness(...seeds: ReadonlyArray<CalendarEvent>) {
  return Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<CalendarEvent>>(seeds);
    const missed = yield* Ref.make<ReadonlyArray<RecordCalendarMissInput>>([]);
    const fired = yield* Ref.make<ReadonlyArray<RecordCalendarFireInput>>([]);
    const notices = yield* Ref.make<ReadonlyArray<CalendarRunNotice>>([]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const listDueCount = yield* Ref.make(0);
    const sweepRan = yield* Deferred.make<void>();
    const shellOverrides = yield* Ref.make<ReadonlyMap<string, ShellOverride>>(new Map());
    const instanceOverrides = yield* Ref.make<ReadonlyMap<string, InstanceOverride>>(new Map());
    const commandDispatchCounts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const sabotageRecordFire = yield* Ref.make(false);

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
        Ref.get(sabotageRecordFire).pipe(
          Effect.flatMap((sabotage) =>
            sabotage
              ? Effect.die(new Error("recordFire unavailable"))
              : Ref.update(fired, (all) => [...all, input]).pipe(
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
          ),
        ),
    });

    const engine = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      // Receipt emulation: a redelivered command id replays the stored
      // outcome — accepted commands replay success, the first notice replay
      // fails like the engine's zero-event duplicate, and later replays fail
      // with the stored rejection the engine recorded for that command id.
      dispatch: (command: OrchestrationCommand) =>
        Ref.get(commandDispatchCounts).pipe(
          Effect.flatMap((counts) => {
            const prior = counts.get(String(command.commandId)) ?? 0;
            const record = Ref.update(commandDispatchCounts, (ids) =>
              new Map(ids).set(String(command.commandId), prior + 1),
            );
            if (prior > 0) {
              if (command.type === "thread.message.system.append") {
                const rejection =
                  prior === 1
                    ? new OrchestrationCommandInvariantError({
                        commandType: command.type,
                        detail: ORCHESTRATION_COMMAND_NO_EVENTS_DETAIL,
                      })
                    : new OrchestrationCommandPreviouslyRejectedError({
                        commandId: String(command.commandId),
                        detail: `Orchestration command invariant failed (${command.type}): ${ORCHESTRATION_COMMAND_NO_EVENTS_DETAIL}`,
                      });
                return record.pipe(Effect.andThen(Effect.fail(rejection)));
              }
              return record.pipe(Effect.as({ sequence: 0 }));
            }
            return record.pipe(
              Effect.andThen(Ref.update(commands, (all) => [...all, command])),
              Effect.as({ sequence: 0 }),
            );
          }),
        ),
    });

    const snapshots = Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(shellOverrides).pipe(
          Effect.map((overrides) => {
            const override = overrides.get(String(threadId));
            if (override !== undefined && "missing" in override) return Option.none();
            if (override !== undefined) return Option.some(override.shell);
            return Option.some(makeShell(threadId));
          }),
        ),
    });

    const providers = Layer.mock(ProviderService)({
      getInstanceInfo: (instanceId) =>
        Ref.get(instanceOverrides).pipe(
          Effect.flatMap((overrides) => {
            const override = overrides.get(String(instanceId));
            if (override !== undefined && "unknown" in override) {
              return Effect.fail(new ProviderUnsupportedError({ provider: String(instanceId) }));
            }
            if (override !== undefined && "transient" in override) {
              return Effect.die(new Error("instance registry unavailable"));
            }
            if (override !== undefined) return Effect.succeed(override.info);
            return Effect.succeed(makeInstanceInfo(instanceId, String(instanceId)));
          }),
        ),
    });

    const hostPower = Layer.succeed(
      HostPowerMonitor.HostPowerMonitor,
      HostPowerMonitor.HostPowerMonitor.of({
        snapshot: Effect.succeed(nominalHostPower),
        report: () => Effect.void,
        streamChanges: Stream.empty,
      }),
    );

    const noticeChannel = Layer.mock(CalendarNotices)({
      // Same key dedupe as the live channel: a retried slot re-records nothing.
      record: (notice) =>
        Ref.update(notices, (all) =>
          all.some((existing) => calendarRunNoticeKey(existing) === calendarRunNoticeKey(notice))
            ? all
            : [...all, notice],
        ).pipe(Effect.asVoid),
    });

    const deps = Layer.mergeAll(
      repository,
      engine,
      hostPower,
      noticeChannel,
      snapshots,
      providers,
      Layer.succeed(Crypto.Crypto, testCrypto),
    );
    const reactor = yield* makeCalendarReactor.pipe(Effect.provide(deps));
    return {
      events,
      missed,
      fired,
      notices,
      commands,
      listDueCount,
      sweepRan,
      shellOverrides,
      instanceOverrides,
      sabotageRecordFire,
      reactor,
    };
  });
}

const countCommands = (commands: ReadonlyArray<OrchestrationCommand>, type: string): number =>
  commands.filter((command) => command.type === type).length;

describe("scheduled run identity", () => {
  it("names the calendar event and marks the run automatic", () => {
    const event = makeCalendarEvent({ nextFireAt: "2026-01-15T13:00:00.000Z" });
    const text = formatCalendarRunMessage(event, "2026-01-15T13:00:00.000Z");
    assert.ok(text.includes(`Calendar event id: ${event.eventId}`));
    assert.ok(text.includes("started automatically"));
    assert.ok(text.includes("do not create, edit, or delete calendar events"));
    assert.ok(text.endsWith(event.message));
  });

  it.effect("the fired turn and created thread carry the automatic-run identity", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({ nextFireAt: "2026-01-15T13:00:00.000Z" }),
      );
      yield* harness.reactor.start();

      const commands = yield* Ref.get(harness.commands);
      const created = commands.find((command) => command.type === "thread.create");
      assert.ok(created !== undefined && created.type === "thread.create");
      assert.ok(created.title.startsWith("Scheduled · "));

      const turn = commands.find((command) => command.type === "thread.turn.start");
      assert.ok(turn !== undefined && turn.type === "thread.turn.start");
      assert.ok(turn.message.text.includes("Calendar event id: event-1"));
      assert.ok(turn.message.text.includes("started automatically"));

      const system = commands.find((command) => command.type === "thread.message.system.append");
      assert.ok(system !== undefined && system.type === "thread.message.system.append");
      assert.ok(system.message.text.includes("(calendar event event-1)"));
    }),
  );
});

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

  it.effect("a restart exactly at the slot instant fires the slot inside grace", () =>
    Effect.gen(function* () {
      assert.equal(CALENDAR_FIRE_GRACE_MS, 5 * 60 * 1000);
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();

      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T15:00:00.000Z");
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "started");
      assert.equal(notices[0]?.scheduledAt, "2026-01-15T14:00:00.000Z");
    }),
  );

  it.effect("fires a slot two minutes late at boot", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 2, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();

      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T14:00:00.000Z");
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
    }),
  );

  it.effect("collapses a slot ten minutes late into one miss and advances", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 10, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* harness.reactor.start();

      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.missedAt, "2026-01-15T13:00:00.000Z");
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T14:00:00.000Z");
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

      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "skipped-missed");
      assert.equal(notices[0]?.scheduledAt, "2026-01-15T13:00:00.000Z");
      assert.equal(notices[0]?.threadId, threadId);
      assert.equal(notices[0]?.name, "Standup");
    }),
  );

  it.effect("a missed new-thread event records a notice but no thread message", () => {
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
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "skipped-missed");
      assert.equal(notices[0]?.threadId, undefined);
      assert.isTrue(
        logs.some(
          (message) =>
            typeof message === "string" && message.includes("missed before a thread existed"),
        ),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("fires in-grace slots the startup cap left due instead of reporting them missed", () =>
    Effect.gen(function* () {
      // Boot 4m50s after the slot: inside the 5m grace, but the cap is spent
      // before the fourth slot, which must fire rather than age out.
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 13, 4, 50));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          eventId: "e-1",
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
        makeCalendarEvent({
          eventId: "e-2",
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-2"),
        }),
        makeCalendarEvent({
          eventId: "e-3",
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-3"),
        }),
        makeCalendarEvent({
          eventId: "e-4",
          nextFireAt: "2026-01-15T13:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-4"),
        }),
      );
      yield* harness.reactor.start();

      assert.equal((yield* Ref.get(harness.missed)).length, 0);
      assert.deepEqual((yield* Ref.get(harness.fired)).map((fire) => fire.eventId).sort(), [
        "e-1",
        "e-2",
        "e-3",
        "e-4",
      ]);
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 4);
      assert.isTrue(notices.every((notice) => notice.status === "started"));
    }),
  );
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

  it.effect("fires recent slots up to the cap while stale slots collapse to one miss", () =>
    Effect.gen(function* () {
      assert.equal(FIRE_PER_SWEEP_LIMIT, 3);
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 12, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({ eventId: "e-a", nextFireAt: "2026-01-16T00:00:00.000Z" }),
        makeCalendarEvent({ eventId: "e-b", nextFireAt: "2026-01-16T00:00:00.000Z" }),
        makeCalendarEvent({ eventId: "e-c", nextFireAt: "2026-01-16T00:00:00.000Z" }),
        makeCalendarEvent({ eventId: "e-d", nextFireAt: "2026-01-16T00:00:00.000Z" }),
        makeCalendarEvent({ eventId: "e-stale", nextFireAt: "2026-01-16T00:00:00.000Z" }),
      );
      yield* harness.reactor.start();
      yield* backdate(
        harness.events,
        new Map([
          ["e-a", "2026-01-15T12:25:30.000Z"], // exactly at the grace boundary (sweep runs at :30)
          ["e-b", "2026-01-15T12:27:00.000Z"],
          ["e-c", "2026-01-15T12:28:00.000Z"],
          ["e-d", "2026-01-15T12:29:00.000Z"],
          ["e-stale", "2026-01-15T11:00:00.000Z"],
        ]),
      );

      yield* TestClock.adjust("30 seconds");
      const firstFires = yield* Ref.get(harness.fired);
      // The stale slot collapses without spending the fire budget.
      assert.deepEqual(
        firstFires.map((fire) => fire.eventId),
        ["e-a", "e-b", "e-c"],
      );
      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.eventId, "e-stale");
      assert.equal(missed[0]?.missedAt, "2026-01-15T11:00:00.000Z");
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T13:00:00.000Z");
      const afterFirst = yield* Ref.get(harness.events);
      assert.equal(
        afterFirst.find((row) => row.eventId === "e-d")?.nextFireAt,
        "2026-01-15T12:29:00.000Z",
      );

      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(
        (yield* Ref.get(harness.fired)).map((fire) => fire.eventId),
        ["e-a", "e-b", "e-c", "e-d"],
      );
    }),
  );

  it.effect("a single due event still fires exactly once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({ nextFireAt: "2026-01-15T08:00:00.000Z" }),
      );
      yield* harness.reactor.start();
      yield* backdate(harness.events, new Map([["event-1", "2026-01-15T07:28:00.000Z"]]));

      yield* TestClock.adjust("30 seconds");
      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T08:00:00.000Z");

      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Ref.get(harness.fired)).length, 1);
    }),
  );

  it.effect("records a started notice when an event fires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const threadId = ThreadId.make("thread-1");
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T08:00:00.000Z",
          mode: "continue",
          threadId,
        }),
      );
      yield* harness.reactor.start();
      yield* backdate(harness.events, new Map([["event-1", "2026-01-15T07:28:00.000Z"]]));

      yield* TestClock.adjust("30 seconds");

      assert.equal((yield* Ref.get(harness.fired)).length, 1);
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "started");
      assert.equal(notices[0]?.scheduledAt, "2026-01-15T07:28:00.000Z");
      assert.equal(notices[0]?.threadId, threadId);
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
          ["event-1", "2026-01-15T07:26:00.000Z"],
          ["event-2", "2026-01-15T07:27:00.000Z"],
          ["event-3", "2026-01-15T07:28:00.000Z"],
          ["event-4", "2026-01-15T07:29:00.000Z"],
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
        "2026-01-15T07:29:00.000Z",
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
          ["event-z", "2026-01-15T07:28:00.000Z"],
          ["event-b", "2026-01-15T07:27:00.000Z"],
          ["event-a", "2026-01-15T07:27:00.000Z"],
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

describe("CalendarReactor continue provider targets", () => {
  const codexSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  };
  const museSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("muse"),
    model: "muse-spark-1.3",
  };

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

  const seedCrossDriverInfos = (harness: {
    readonly instanceOverrides: Ref.Ref<ReadonlyMap<string, InstanceOverride>>;
  }) =>
    Ref.update(harness.instanceOverrides, (overrides) =>
      new Map(overrides)
        .set("codex", {
          info: makeInstanceInfo(ProviderInstanceId.make("codex"), "codex", "codex:instance:codex"),
        })
        .set("muse", {
          info: makeInstanceInfo(
            ProviderInstanceId.make("muse"),
            "museCode",
            "museCode:instance:muse",
          ),
        }),
    );

  it.effect("repoints a continue thread across drivers before starting the turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
          modelSelection: museSelection,
        }),
      );
      yield* seedCrossDriverInfos(harness);
      yield* harness.reactor.start();

      const commands = yield* Ref.get(harness.commands);
      assert.equal(commands.length, 3);
      const [meta, turn, notice] = commands;
      assert.ok(meta !== undefined && meta.type === "thread.meta.update");
      if (meta?.type === "thread.meta.update") {
        assert.equal(meta.threadId, ThreadId.make("thread-1"));
        assert.deepEqual(meta.modelSelection, museSelection);
        assert.equal(meta.commandId, "calendar:meta:event-1:2026-01-15T14:00:00.000Z");
      }
      assert.ok(turn !== undefined && turn.type === "thread.turn.start");
      if (turn?.type === "thread.turn.start") {
        // Explicit repeat of the durable target: a stale reader rejects this
        // loudly instead of starting the old driver silently.
        assert.deepEqual(turn.modelSelection, museSelection);
        assert.ok(turn.message.text.includes("Calendar event id: event-1"));
      }
      assert.ok(notice !== undefined && notice.type === "thread.message.system.append");

      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T15:00:00.000Z");
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
    }),
  );

  it.effect("retries a transient instance lookup inside grace instead of closing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* Ref.update(harness.instanceOverrides, (overrides) =>
        new Map(overrides).set("codex", { transient: true }),
      );
      yield* harness.reactor.start();

      assert.equal(countCommands(yield* Ref.get(harness.commands), "thread.turn.start"), 0);
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
      assert.equal((yield* Ref.get(harness.notices)).length, 0);
      const rows = yield* Ref.get(harness.events);
      assert.equal(
        rows.find((row) => row.eventId === "event-1")?.nextFireAt,
        "2026-01-15T14:00:00.000Z",
      );

      yield* Ref.update(harness.instanceOverrides, (overrides) =>
        new Map(overrides).set("codex", {
          info: makeInstanceInfo(ProviderInstanceId.make("codex"), "codex", "codex:instance:codex"),
        }),
      );
      yield* TestClock.adjust("30 seconds");

      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T15:00:00.000Z");
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
    }),
  );

  it.effect("keeps the one-off override on the same driver", () =>
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

      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.meta.update"), 0);
      const turn = commands.find((command) => command.type === "thread.turn.start");
      assert.ok(turn !== undefined && turn.type === "thread.turn.start");
      if (turn?.type === "thread.turn.start") {
        assert.deepEqual(turn.modelSelection, codexSelection);
      }
      assert.equal((yield* Ref.get(harness.fired)).length, 1);
    }),
  );

  it.effect("defers a busy continue thread without spending fire budget", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          eventId: "e-busy",
          nextFireAt: "2026-01-16T00:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-busy"),
        }),
        makeCalendarEvent({
          eventId: "e-2",
          nextFireAt: "2026-01-16T00:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-2"),
        }),
        makeCalendarEvent({
          eventId: "e-3",
          nextFireAt: "2026-01-16T00:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-3"),
        }),
        makeCalendarEvent({
          eventId: "e-4",
          nextFireAt: "2026-01-16T00:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-4"),
        }),
      );
      const busyThread = ThreadId.make("thread-busy");
      yield* Ref.update(harness.shellOverrides, (overrides) =>
        new Map(overrides).set(String(busyThread), {
          shell: makeShell(busyThread, { session: makeBusySession(busyThread) }),
        }),
      );
      yield* harness.reactor.start();
      yield* backdate(
        harness.events,
        new Map([
          ["e-busy", "2026-01-15T07:29:00.000Z"],
          ["e-2", "2026-01-15T07:26:00.000Z"],
          ["e-3", "2026-01-15T07:27:00.000Z"],
          ["e-4", "2026-01-15T07:28:00.000Z"],
        ]),
      );

      yield* TestClock.adjust("30 seconds");
      // All three ready events fire in one sweep: the busy slot spent nothing.
      assert.deepEqual(
        (yield* Ref.get(harness.fired)).map((fire) => fire.eventId),
        ["e-2", "e-3", "e-4"],
      );
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
      const rows = yield* Ref.get(harness.events);
      assert.equal(
        rows.find((row) => row.eventId === "e-busy")?.nextFireAt,
        "2026-01-15T07:29:00.000Z",
      );
      const commands = yield* Ref.get(harness.commands);
      assert.isTrue(
        commands.every(
          (command) =>
            command.type !== "thread.turn.start" ||
            !command.message.text.includes("Calendar event id: e-busy"),
        ),
      );
    }),
  );

  it.effect("collapses a busy slot that aged out of grace into one miss", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 7, 30, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-16T00:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      const threadId = ThreadId.make("thread-1");
      yield* Ref.update(harness.shellOverrides, (overrides) =>
        new Map(overrides).set(String(threadId), {
          shell: makeShell(threadId, { session: makeBusySession(threadId) }),
        }),
      );
      yield* harness.reactor.start();
      yield* backdate(harness.events, new Map([["event-1", "2026-01-15T06:00:00.000Z"]]));

      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.missedAt, "2026-01-15T06:00:00.000Z");
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T08:00:00.000Z");
    }),
  );

  it.effect("closes the slot when the continue thread is gone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
        }),
      );
      yield* Ref.update(harness.shellOverrides, (overrides) =>
        new Map(overrides).set(String(ThreadId.make("thread-1")), { missing: true }),
      );
      yield* harness.reactor.start();

      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 0);
      assert.equal(countCommands(commands, "thread.meta.update"), 0);
      assert.equal(commands.length, 0);
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      const missed = yield* Ref.get(harness.missed);
      assert.equal(missed.length, 1);
      assert.equal(missed[0]?.missedAt, "2026-01-15T14:00:00.000Z");
      assert.equal(missed[0]?.nextFireAt, "2026-01-15T15:00:00.000Z");
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "skipped-missed");
    }),
  );

  it.effect("closes the slot when the event model instance is unknown", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("ghost"),
            model: "vanished-1",
          },
        }),
      );
      yield* Ref.update(harness.instanceOverrides, (overrides) =>
        new Map(overrides).set("ghost", { unknown: true }),
      );
      yield* harness.reactor.start();

      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 0);
      assert.equal(countCommands(commands, "thread.meta.update"), 0);
      assert.equal(commands.length, 1);
      const explainer = commands[0];
      assert.ok(explainer !== undefined && explainer.type === "thread.message.system.append");
      if (explainer?.type === "thread.message.system.append") {
        assert.ok(explainer.message.text.includes("ghost"));
        assert.ok(explainer.message.text.includes("not configured"));
      }
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      assert.equal((yield* Ref.get(harness.missed)).length, 1);
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "skipped-missed");
      assert.equal(notices[0]?.threadId, ThreadId.make("thread-1"));
    }),
  );

  it.effect("closes the slot on incompatible same-driver resume state", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const threadId = ThreadId.make("thread-1");
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("instance-b"),
            model: "model-b",
          },
        }),
      );
      yield* Ref.update(harness.shellOverrides, (overrides) =>
        new Map(overrides).set(String(threadId), {
          shell: makeShell(threadId, {
            modelSelection: {
              instanceId: ProviderInstanceId.make("instance-a"),
              model: "model-a",
            },
          }),
        }),
      );
      yield* Ref.update(harness.instanceOverrides, (overrides) =>
        new Map(overrides)
          .set("instance-a", {
            info: makeInstanceInfo(ProviderInstanceId.make("instance-a"), "codex", "codex:key-a"),
          })
          .set("instance-b", {
            info: makeInstanceInfo(ProviderInstanceId.make("instance-b"), "codex", "codex:key-b"),
          }),
      );
      yield* harness.reactor.start();

      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 0);
      assert.equal(countCommands(commands, "thread.meta.update"), 0);
      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      assert.equal((yield* Ref.get(harness.missed)).length, 1);
      const explainer = commands.find((command) => command.type === "thread.message.system.append");
      assert.ok(
        explainer !== undefined &&
          explainer.type === "thread.message.system.append" &&
          explainer.message.text.includes("incompatible"),
      );
    }),
  );

  it.effect("a crash between notify and recordFire never fires the turn twice", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 15, 14, 0, 0));
      const harness = yield* makeStartupHarness(
        makeCalendarEvent({
          nextFireAt: "2026-01-15T14:00:00.000Z",
          mode: "continue",
          threadId: ThreadId.make("thread-1"),
          modelSelection: museSelection,
        }),
      );
      yield* seedCrossDriverInfos(harness);
      yield* Ref.set(harness.sabotageRecordFire, true);
      yield* harness.reactor.start();

      assert.equal((yield* Ref.get(harness.fired)).length, 0);
      assert.equal((yield* Ref.get(harness.missed)).length, 0);

      // Second fire replays the persisted notice as a zero-event duplicate.
      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Ref.get(harness.fired)).length, 0);

      // Third fire replays it as the stored rejection the engine recorded.
      yield* Ref.set(harness.sabotageRecordFire, false);
      yield* TestClock.adjust("30 seconds");

      const commands = yield* Ref.get(harness.commands);
      assert.equal(countCommands(commands, "thread.turn.start"), 1);
      assert.equal(countCommands(commands, "thread.meta.update"), 1);
      const fired = yield* Ref.get(harness.fired);
      assert.equal(fired.length, 1);
      assert.equal(fired[0]?.nextFireAt, "2026-01-15T15:00:00.000Z");
      assert.equal((yield* Ref.get(harness.missed)).length, 0);
      const notices = yield* Ref.get(harness.notices);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.status, "started");
    }),
  );
});
