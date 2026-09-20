/**
 * CalendarReactor - fires scheduled calendar events.
 *
 * One sweep reads rows whose persisted `next_fire_at` is due and dispatches a
 * `thread.turn.start` into the target thread. A separate startup branch treats
 * any slot already in the past as missed (host asleep or server restart), skips
 * it, posts a notification, and advances the schedule from now. No scheduler
 * dependency is used: repeats are 5-field local-time cron expressions and the
 * next absolute instant is stored per row.
 *
 * @module CalendarReactor
 */
// @effect-diagnostics globalDate:off -- Cron day arithmetic uses UTC calendar fields; wall-clock math goes through Effect DateTime.
import {
  CalendarEvent,
  calendarNameExcerpt,
  CommandId,
  MessageId,
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
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const SWEEP_INTERVAL = "30 seconds";
const DUE_LIMIT = 50;
const MAX_LOOKAHEAD_DAYS = 366 * 8;

/** Schedule exhausted because no future slot matched; never treated as due. */
const EXHAUSTED_NEXT_FIRE_AT = "9999-12-31T23:59:59.000Z";

interface ParsedCronField {
  readonly values: ReadonlySet<number>;
  readonly restricted: boolean;
}

interface ParsedCalendarCron {
  readonly minute: ParsedCronField;
  readonly hour: ParsedCronField;
  readonly dayOfMonth: ParsedCronField;
  readonly month: ParsedCronField;
  readonly dayOfWeek: ParsedCronField;
}

function parseCronField(raw: string, min: number, max: number): ParsedCronField | null {
  const field = raw.trim();
  if (field.length === 0) return null;
  const values = new Set<number>();
  for (const token of field.split(",")) {
    const piece = token.trim();
    if (piece.length === 0) return null;
    const slashIndex = piece.indexOf("/");
    if (slashIndex !== -1 && piece.indexOf("/", slashIndex + 1) !== -1) return null;
    const rangePart = slashIndex === -1 ? piece : piece.slice(0, slashIndex);
    const stepPart = slashIndex === -1 ? undefined : piece.slice(slashIndex + 1);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else {
      const dashIndex = rangePart.indexOf("-");
      if (dashIndex === -1) {
        if (!/^\d+$/.test(rangePart)) return null;
        start = Number(rangePart);
        end = stepPart === undefined ? start : max;
      } else {
        const startPart = rangePart.slice(0, dashIndex);
        const endPart = rangePart.slice(dashIndex + 1);
        if (!/^\d+$/.test(startPart) || !/^\d+$/.test(endPart)) return null;
        start = Number(startPart);
        end = Number(endPart);
      }
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      // Cron accepts both 0 and 7 for Sunday.
      values.add(max === 7 && value === 7 ? 0 : value);
    }
  }
  return { values, restricted: field !== "*" };
}

/** @internal Exported for tests. */
export function parseCalendarCron(expression: string): ParsedCalendarCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0]!, 0, 59);
  const hour = parseCronField(fields[1]!, 0, 23);
  const dayOfMonth = parseCronField(fields[2]!, 1, 31);
  const month = parseCronField(fields[3]!, 1, 12);
  const dayOfWeek = parseCronField(fields[4]!, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function matchesCalendarDay(parsed: ParsedCalendarCron, day: number, weekday: number): boolean {
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(day);
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(weekday);
  // Standard cron: when both day fields are restricted, either may match.
  if (parsed.dayOfMonth.restricted && parsed.dayOfWeek.restricted) {
    return dayOfMonthMatch || dayOfWeekMatch;
  }
  if (parsed.dayOfMonth.restricted) return dayOfMonthMatch;
  if (parsed.dayOfWeek.restricted) return dayOfWeekMatch;
  return true;
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
  const hours = [...parsed.hour.values].sort((left, right) => left - right);
  const minutes = [...parsed.minute.values].sort((left, right) => left - right);
  // Calendar-day arithmetic on UTC fields is zone-independent and DST-safe.
  const startDay = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day);
  for (let dayOffset = 0; dayOffset <= MAX_LOOKAHEAD_DAYS; dayOffset += 1) {
    const cursor = new Date(startDay + dayOffset * 86_400_000);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();
    if (!parsed.month.values.has(month)) continue;
    if (!matchesCalendarDay(parsed, day, weekday)) continue;
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
    yield* repository.recordFire({
      eventId: event.eventId,
      firedAt,
      nextFireAt: nextFireAtFor(event, scheduledAt),
      updatedAt: firedAt,
    });
  });

  const skipMissedAtStartup = Effect.fn("CalendarReactor.skipMissedAtStartup")(function* () {
    const observedAt = yield* nowIso;
    const power = yield* hostPower.snapshot;
    const events = yield* repository.listAll();
    for (const event of events) {
      if (compareDateTimeStrings(event.nextFireAt, observedAt) > 0) continue;
      const scheduledAt = event.nextFireAt;
      const nextFireAt = nextFireAtFor(event, observedAt);
      yield* repository.recordMissed({
        eventId: event.eventId,
        missedAt: scheduledAt,
        nextFireAt,
        updatedAt: observedAt,
      });
      if (event.threadId === null) {
        // A new-thread event has no target thread yet; the persisted
        // last_missed_at is the notification the UI reads on launch.
        yield* Effect.logWarning("calendar event missed before a thread existed", {
          eventId: event.eventId,
          scheduledAt,
          hostSuspended: power.suspended,
          hostStale: power.stale,
        });
        continue;
      }
      yield* notify(event.threadId, event, "skipped-missed", scheduledAt, observedAt);
    }
  });

  const sweep = Effect.fn("CalendarReactor.sweep")(function* () {
    const observedAt = yield* nowIso;
    const due = yield* repository.listDue({ nowIso: observedAt, limit: DUE_LIMIT });
    yield* Effect.forEach(
      due,
      (event) =>
        fire(event).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("calendar event fire failed", {
                  eventId: event.eventId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  const start: CalendarReactor["Service"]["start"] = Effect.fn("CalendarReactor.start")(
    function* () {
      yield* skipMissedAtStartup().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("calendar startup miss sweep failed", {
                cause: Cause.pretty(cause),
              }),
        ),
      );
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
