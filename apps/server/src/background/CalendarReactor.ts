/**
 * CalendarReactor - fires scheduled calendar events.
 *
 * One sweep reads rows whose persisted `next_fire_at` is due. A slot at most
 * `CALENDAR_FIRE_GRACE_MS` in the past runs late ("as if" it just came due),
 * earliest slot first and at most `FIRE_PER_SWEEP_LIMIT` fires total; unfired
 * recent rows keep their schedule. An older slot collapses into a single miss
 * and advances the schedule from now, the same way the startup branch handles a
 * restart: the startup partition is the sweep partition, not "every past slot
 * is missed". Collapsing misses never spends fire budget. No scheduler
 * dependency is used: repeats are 5-field local-time cron expressions and the
 * next absolute instant is stored per row.
 *
 * @module CalendarReactor
 */
// @effect-diagnostics globalDate:off -- Cron day arithmetic uses UTC calendar fields; wall-clock math goes through Effect DateTime.
import {
  CALENDAR_CRON_LOOKAHEAD_DAYS,
  CalendarEvent,
  calendarCronMatchesDay,
  calendarCronSortedValues,
  calendarNameExcerpt,
  type CalendarUpdateInput,
  CommandId,
  type HostPowerSnapshot,
  MessageId,
  parseCalendarCron,
  ThreadId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { CalendarEventRepository } from "../persistence/Services/CalendarEvents.ts";
import { CalendarNotices } from "./CalendarNotices.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const SWEEP_INTERVAL = "30 seconds";
const DUE_LIMIT = 50;

/**
 * Most fires one sweep may dispatch across all events. Bounds the burst a
 * delayed tick (host sleep) can emit; leftover due work waits for the next
 * sweep with its schedule untouched.
 */
export const FIRE_PER_SWEEP_LIMIT = 3;

/**
 * How long after its slot a due event may still run late. Inside the window the
 * slot fires (catch-up preserved); outside it is collapsed into one miss and the
 * schedule advances from now, so a long host sleep does not replay the backlog.
 */
export const CALENDAR_FIRE_GRACE_MS = 5 * 60 * 1000;

/** Schedule exhausted because no future slot matched; never treated as due. */
const EXHAUSTED_NEXT_FIRE_AT = "9999-12-31T23:59:59.000Z";

/**
 * True when a due `scheduledAt` is at most `CALENDAR_FIRE_GRACE_MS` behind
 * `observedAt` (boundary inclusive). Shared by the sweep and startup branches so
 * both use the same window.
 */
const isWithinFireGrace = (scheduledAt: string, observedAt: string): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(observedAt)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(scheduledAt)) <=
  CALENDAR_FIRE_GRACE_MS;

/** Earliest slot first, then event id, so the cap never starves a due event. */
function compareDueCalendarEvents(left: CalendarEvent, right: CalendarEvent): number {
  const byTime = compareDateTimeStrings(left.nextFireAt, right.nextFireAt);
  if (byTime !== 0) return byTime;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

/**
 * First local wall-clock slot strictly after `fromIso`, expressed as an
 * absolute ISO instant. `null` when the expression is invalid or no slot
 * matches within the lookahead window.
 *
 * @internal Exported for tests.
 */
export function nextCalendarFireAt(
  expression: string,
  timeZone: string,
  fromIso: string,
): string | null {
  const parsed = parseCalendarCron(expression);
  if (parsed === null) return null;
  const from = DateTime.makeUnsafe(fromIso);
  const base = DateTime.setZoneNamed(from, timeZone);
  if (Option.isNone(base)) return null;
  const baseParts = DateTime.toParts(base.value);
  const hours = calendarCronSortedValues(parsed.hour);
  const minutes = calendarCronSortedValues(parsed.minute);
  // Calendar-day arithmetic on UTC fields is zone-independent and DST-safe.
  const startDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);
  for (let dayOffset = 0; dayOffset <= CALENDAR_CRON_LOOKAHEAD_DAYS; dayOffset += 1) {
    const cursor = new Date(startDay + dayOffset * 86_400_000);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();
    if (!parsed.month.values.has(month)) continue;
    if (!calendarCronMatchesDay(parsed, day, weekday)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = DateTime.makeZoned(
          { year, month, day, hour, minute, second: 0, millisecond: 0 },
          { timeZone, adjustForTimeZone: true, disambiguation: "compatible" },
        );
        if (Option.isNone(candidate)) continue;
        const zoned = candidate.value;
        if (!DateTime.isGreaterThan(zoned, from)) continue;
        const parts = DateTime.toParts(zoned);
        // A DST gap can shift the resolved instant; require the wall clock match.
        if (
          parts.year !== year ||
          parts.month !== month ||
          parts.day !== day ||
          parts.hour !== hour ||
          parts.minute !== minute
        ) {
          continue;
        }
        return DateTime.formatIso(zoned);
      }
    }
  }
  return null;
}

/**
 * Merge an edit into an existing event. The editable fields are replaced;
 * `projectId` and the run history are kept. A changed cron or zone recomputes
 * `nextFireAt` from `updatedAt`, while a text/model-only edit leaves the
 * current schedule in place. Returns `null` when a changed schedule has no
 * upcoming slot.
 *
 * @internal Exported for tests.
 */
export function planCalendarEventUpdate(
  current: CalendarEvent,
  input: CalendarUpdateInput,
  updatedAt: string,
): CalendarEvent | null {
  const scheduleChanged =
    input.cronExpression !== current.cronExpression || input.timeZone !== current.timeZone;
  const nextFireAt = scheduleChanged
    ? nextCalendarFireAt(input.cronExpression, input.timeZone, updatedAt)
    : current.nextFireAt;
  if (nextFireAt === null) return null;
  return {
    ...current,
    title: input.title,
    message: input.message,
    mode: input.mode,
    cronExpression: input.cronExpression,
    timeZone: input.timeZone,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    nextFireAt,
    updatedAt,
  };
}

export class CalendarReactor extends Context.Service<
  CalendarReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/background/CalendarReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* CalendarEventRepository;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const hostPower = yield* HostPowerMonitor.HostPowerMonitor;
  const notices = yield* CalendarNotices;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const nextFireAtFor = (event: CalendarEvent, fromIso: string): string =>
    nextCalendarFireAt(event.cronExpression, event.timeZone, fromIso) ?? EXHAUSTED_NEXT_FIRE_AT;

  // The thread-completion channel: a server system message on the target thread.
  const notify = (
    threadId: ThreadId,
    event: CalendarEvent,
    status: "started" | "skipped-missed",
    scheduledAt: string,
    observedAt: string,
  ) =>
    engine.dispatch({
      type: "thread.message.system.append",
      commandId: CommandId.make(`calendar:notice:${status}:${event.eventId}:${scheduledAt}`),
      threadId,
      message: {
        messageId: MessageId.make(`calendar:notice:${status}:${event.eventId}:${scheduledAt}`),
        text:
          status === "started"
            ? `Scheduled run started at ${observedAt}: ${calendarNameExcerpt(event.title)}`
            : `Scheduled run skipped (missed at ${scheduledAt}): ${calendarNameExcerpt(event.title)}`,
      },
      createdAt: observedAt,
    });

  // The client-facing channel behind the notices list and its unread badge.
  const recordNotice = (
    event: CalendarEvent,
    status: "started" | "skipped-missed",
    scheduledAt: string,
    observedAt: string,
    threadId: ThreadId | null,
  ) =>
    notices.record({
      version: 1,
      eventId: event.eventId,
      status,
      scheduledAt,
      observedAt,
      name: calendarNameExcerpt(event.title),
      threadId,
    });

  const fire = Effect.fn("CalendarReactor.fire")(function* (event: CalendarEvent) {
    const firedAt = yield* nowIso;
    const scheduledAt = event.nextFireAt;
    const slotKey = `${event.eventId}:${scheduledAt}`;
    const existingThreadId = event.mode === "continue" ? event.threadId : null;

    let threadId: ThreadId;
    if (existingThreadId !== null) {
      threadId = existingThreadId;
    } else {
      threadId = ThreadId.make(yield* crypto.randomUUIDv4);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`calendar:create:${slotKey}`),
        threadId,
        projectId: event.projectId,
        title: calendarNameExcerpt(event.title) || "Scheduled run",
        modelSelection: event.modelSelection,
        runtimeMode: event.runtimeMode,
        interactionMode: event.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: firedAt,
      });
      if (event.mode === "continue") {
        yield* repository.setThreadId({ eventId: event.eventId, threadId, updatedAt: firedAt });
      }
    }

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`calendar:turn:${slotKey}`),
      threadId,
      message: {
        messageId: MessageId.make(`calendar:turn:${slotKey}`),
        role: "user",
        text: event.message,
        attachments: [],
      },
      modelSelection: event.modelSelection,
      titleSeed: event.title,
      runtimeMode: event.runtimeMode,
      interactionMode: event.interactionMode,
      createdAt: firedAt,
    });

    yield* notify(threadId, event, "started", scheduledAt, firedAt);
    yield* recordNotice(event, "started", scheduledAt, firedAt, threadId);
    yield* repository.recordFire({
      eventId: event.eventId,
      firedAt,
      nextFireAt: nextFireAtFor(event, scheduledAt),
      updatedAt: firedAt,
    });
  });

  // Collapse a stale slot: one miss, the schedule advanced from now, and the
  // notice/thread channels updated the same way boot has always done it.
  const collapseMissedSlot = Effect.fn("CalendarReactor.collapseMissedSlot")(function* (
    event: CalendarEvent,
    observedAt: string,
    power: HostPowerSnapshot,
  ) {
    const scheduledAt = event.nextFireAt;
    const nextFireAt = nextFireAtFor(event, observedAt);
    yield* repository.recordMissed({
      eventId: event.eventId,
      missedAt: scheduledAt,
      nextFireAt,
      updatedAt: observedAt,
    });
    if (event.threadId === null) {
      // A new-thread event has no target thread yet; the notice channel still
      // carries the miss, and the persisted last_missed_at is the event history.
      yield* recordNotice(event, "skipped-missed", scheduledAt, observedAt, null);
      yield* Effect.logWarning("calendar event missed before a thread existed", {
        eventId: event.eventId,
        scheduledAt,
        hostSuspended: power.suspended,
        hostStale: power.stale,
      });
      return;
    }
    yield* notify(event.threadId, event, "skipped-missed", scheduledAt, observedAt);
    yield* recordNotice(event, "skipped-missed", scheduledAt, observedAt, event.threadId);
  });

  const fireOnSweep = (event: CalendarEvent, label: string, failed?: Set<string>) =>
    fire(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        failed?.add(event.eventId);
        return Effect.logWarning(label, {
          eventId: event.eventId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // Returns true when the fire cap left an in-grace slot due; the caller runs
  // one sweep at the boot instant so it fires before it can age out.
  const skipMissedAtStartup = Effect.fn("CalendarReactor.skipMissedAtStartup")(function* () {
    const observedAt = yield* nowIso;
    const power = yield* hostPower.snapshot;
    const events = yield* repository.listAll();
    let budget = FIRE_PER_SWEEP_LIMIT;
    let leftDueInGrace = false;
    for (const event of events) {
      if (compareDateTimeStrings(event.nextFireAt, observedAt) > 0) continue;
      if (isWithinFireGrace(event.nextFireAt, observedAt)) {
        // A slot inside the grace window runs late; when the cap is spent it
        // stays due for the immediate first sweep instead of being recorded as
        // missed.
        if (budget <= 0) {
          leftDueInGrace = true;
          continue;
        }
        budget -= 1;
        yield* fireOnSweep(event, "calendar event fire failed at startup");
        continue;
      }
      yield* collapseMissedSlot(event, observedAt, power);
    }
    return leftDueInGrace;
  });

  const sweep = Effect.fn("CalendarReactor.sweep")(function* () {
    const observedAt = yield* nowIso;
    const power = yield* hostPower.snapshot;
    const failed = new Set<string>();
    let budget = FIRE_PER_SWEEP_LIMIT;
    // Re-query each pass: catch-up within the grace window advances slot by
    // slot while the budget caps the sweep, and a failed event cannot burn the
    // whole budget. Stale slots collapse first so a backlog never starves the
    // recent slots the fire budget exists to bound.
    while (true) {
      const due = yield* repository.listDue({ nowIso: observedAt, limit: DUE_LIMIT });
      const pending = due.filter((event) => !failed.has(event.eventId));
      for (const event of pending) {
        if (isWithinFireGrace(event.nextFireAt, observedAt)) continue;
        yield* collapseMissedSlot(event, observedAt, power).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            failed.add(event.eventId);
            return Effect.logWarning("calendar event miss collapse failed", {
              eventId: event.eventId,
              cause: Cause.pretty(cause),
            });
          }),
        );
      }
      const next = pending
        .filter((event) => isWithinFireGrace(event.nextFireAt, observedAt))
        .sort(compareDueCalendarEvents)[0];
      if (next === undefined || budget <= 0) break;
      yield* fireOnSweep(next, "calendar event fire failed", failed);
      budget -= 1;
    }
  });

  const start: CalendarReactor["Service"]["start"] = Effect.fn("CalendarReactor.start")(
    function* () {
      const leftDueInGrace = yield* skipMissedAtStartup().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("calendar startup miss sweep failed", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );
      // A capped startup sweep can leave an in-grace slot due. Claim it now,
      // before the 30s sleep, so it fires instead of aging out of grace.
      if (leftDueInGrace) {
        yield* sweep().pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("calendar startup catch-up sweep failed", {
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      }
      yield* Effect.forever(
        Effect.sleep(SWEEP_INTERVAL).pipe(
          Effect.andThen(
            sweep().pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("calendar sweep failed", { cause: Cause.pretty(cause) }),
              ),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped, Effect.asVoid);
    },
  );

  return { start } satisfies CalendarReactor["Service"];
});

export const layer = Layer.effect(CalendarReactor, make);
