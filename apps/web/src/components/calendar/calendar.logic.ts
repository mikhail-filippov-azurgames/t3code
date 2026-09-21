/**
 * Pure calendar math and copy for the schedule view.
 *
 * The server owns the next absolute fire instant; the client only needs to
 * place occurrences on the visible grid and derive an optimistic next fire for
 * an event created before the calendar RPCs are wired. Repeats are the same
 * five-field cron the contract stores, read in local wall-clock time.
 *
 * Display policy: everything renders in the browser zone. `event.timeZone`
 * drives the server fire only and is never used as a display zone here.
 *
 * @module components/calendar/calendar.logic
 */
import {
  CALENDAR_CRON_LOOKAHEAD_DAYS,
  calendarCronMatchesDay,
  calendarCronSortedValues,
  calendarNameExcerpt,
  calendarRunNoticeKey,
  type CalendarEvent,
  type CalendarEventMode,
  type CalendarRunNotice,
  type CalendarRunNoticeStatus,
  type ParsedCalendarCron,
  parseCalendarCron,
} from "@t3tools/contracts";

export type CalendarRepeat = "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

export const CALENDAR_REPEAT_OPTIONS: ReadonlyArray<{
  readonly value: CalendarRepeat;
  readonly label: string;
}> = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly (specific date)" },
  { value: "custom", label: "Custom cron" },
];

export const CALENDAR_MODE_OPTIONS: ReadonlyArray<{
  readonly value: CalendarEventMode;
  readonly label: string;
}> = [
  { value: "new-thread", label: "New thread each time" },
  { value: "continue", label: "Continue one thread" },
];

/** Cosmetic only: the contract carries no duration, so a chip gets a fixed one. */
export const DEFAULT_EVENT_MINUTES = 45;

/** The contract owns cron parsing; the client reads the same five-field expression. */
export const parseCron = parseCalendarCron;
export type ParsedCron = ParsedCalendarCron;

/**
 * Standard cron day rule: a restricted day-of-month and day-of-week are ORed,
 * while a `*` field leaves the other one in charge.
 */
export function cronMatchesDay(cron: ParsedCalendarCron, date: Date): boolean {
  if (!cron.month.values.has(date.getMonth() + 1)) return false;
  return calendarCronMatchesDay(cron, date.getDate(), date.getDay());
}

/**
 * A local wall clock that does not exist (spring-forward gap) resolves to a
 * different clock reading; reject it so the client matches the server's gate.
 */
function matchesWallClock(
  candidate: Date,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  return (
    candidate.getFullYear() === year &&
    candidate.getMonth() === monthIndex &&
    candidate.getDate() === day &&
    candidate.getHours() === hour &&
    candidate.getMinutes() === minute
  );
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfWeek(date: Date, weekStartsOn: number): Date {
  const start = startOfDay(date);
  const offset = (start.getDay() - weekStartsOn + 7) % 7;
  return addDays(start, -offset);
}

/** Single source for the display zone: the browser's IANA zone. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Zone caption for grid headers and similar spots, rendered via Intl. */
export function formatTimeZoneLabel(date: Date = new Date()): string {
  const zone = browserTimeZone();
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? zone;
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: browserTimeZone(),
  });
}

export function formatDayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: browserTimeZone(),
  });
}

/** Compose the cron the form's chosen start instant and repeat imply. */
export function composeCron(date: Date, repeat: CalendarRepeat, custom = ""): string {
  const minute = date.getMinutes();
  const hour = date.getHours();
  switch (repeat) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${date.getDay()}`;
    case "monthly":
      return `${minute} ${hour} ${date.getDate()} * *`;
    case "yearly":
      return `${minute} ${hour} ${date.getDate()} ${date.getMonth() + 1} *`;
    case "custom":
      return custom.trim();
  }
}

/**
 * Reverse of {@link composeCron} for the form's prefill: recognise the simple
 * shapes the form itself produces and fall back to `"custom"` for anything else
 * (stepped ranges, lists, multiple hours), which keeps the raw expression.
 */
export function inferCalendarRepeat(expression: string): CalendarRepeat {
  const cron = parseCron(expression);
  if (cron === null) return "custom";
  const singleMinute = cron.minute.values.size === 1;
  const singleHour = cron.hour.values.size === 1;
  const anyDom = !cron.dayOfMonth.restricted;
  const anyMonth = !cron.month.restricted;
  const anyDow = !cron.dayOfWeek.restricted;
  if (singleMinute && !cron.hour.restricted && anyDom && anyMonth && anyDow) return "hourly";
  if (singleMinute && singleHour && anyDom && anyMonth && anyDow) return "daily";
  if (singleMinute && singleHour && anyDom && anyMonth && cron.dayOfWeek.values.size === 1) {
    return "weekly";
  }
  if (singleMinute && singleHour && cron.dayOfMonth.values.size === 1 && anyMonth && anyDow) {
    return "monthly";
  }
  if (
    singleMinute &&
    singleHour &&
    cron.dayOfMonth.values.size === 1 &&
    cron.month.values.size === 1 &&
    anyDow
  ) {
    return "yearly";
  }
  return "custom";
}

export interface CalendarOccurrence {
  readonly event: CalendarEvent;
  readonly start: Date;
  readonly end: Date;
}

/**
 * Occurrences of one event that start inside `[rangeStart, rangeEnd)`.
 * Iterates days, then the cron's own hour and minute sets, so cost tracks how
 * many times a repeat actually fires rather than the width of the window.
 */
export function eventOccurrencesBetween(
  event: CalendarEvent,
  rangeStart: Date,
  rangeEnd: Date,
): ReadonlyArray<Date> {
  const cron = parseCron(event.cronExpression);
  if (cron === null || rangeStart.getTime() >= rangeEnd.getTime()) return [];
  const hours = calendarCronSortedValues(cron.hour);
  const minutes = calendarCronSortedValues(cron.minute);
  const occurrences: Date[] = [];
  for (
    let day = startOfDay(rangeStart);
    day.getTime() < rangeEnd.getTime();
    day = addDays(day, 1)
  ) {
    if (!cronMatchesDay(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (
          !matchesWallClock(
            candidate,
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hour,
            minute,
          )
        ) {
          continue;
        }
        if (
          candidate.getTime() >= rangeStart.getTime() &&
          candidate.getTime() < rangeEnd.getTime()
        ) {
          occurrences.push(candidate);
        }
      }
    }
  }
  return occurrences;
}

export function layoutOccurrences(
  events: ReadonlyArray<CalendarEvent>,
  rangeStart: Date,
  rangeEnd: Date,
  durationMinutes = DEFAULT_EVENT_MINUTES,
): ReadonlyArray<CalendarOccurrence> {
  const durationMs = durationMinutes * 60_000;
  return events
    .flatMap((event) =>
      eventOccurrencesBetween(event, rangeStart, rangeEnd).map((start) => ({
        event,
        start,
        end: new Date(start.getTime() + durationMs),
      })),
    )
    .toSorted((left, right) => left.start.getTime() - right.start.getTime());
}

/** The first fire at or after `from`, or null when the expression never matches. */
export function nextCronOccurrence(expression: string, from: Date): Date | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  const hours = calendarCronSortedValues(cron.hour);
  const minutes = calendarCronSortedValues(cron.minute);
  const start = new Date(from);
  start.setSeconds(0, 0);
  for (let offset = 0; offset <= CALENDAR_CRON_LOOKAHEAD_DAYS; offset += 1) {
    const day = addDays(startOfDay(start), offset);
    if (!cronMatchesDay(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (
          !matchesWallClock(
            candidate,
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hour,
            minute,
          )
        ) {
          continue;
        }
        if (candidate.getTime() >= start.getTime()) return candidate;
      }
    }
  }
  return null;
}

export interface CalendarNoticePresentation {
  readonly title: string;
  readonly body: string;
  readonly tone: "success" | "warning";
}

/**
 * The run notice the server posts is already capped at 60 chars, but the
 * notification body is a second place a long name could leak, so the excerpt
 * helper stays in the path.
 */
export function describeCalendarRunNotice(
  notice: CalendarRunNotice,
  formatTime: (iso: string) => string = (iso) => formatClock(new Date(iso)),
): CalendarNoticePresentation {
  const name = calendarNameExcerpt(notice.name);
  const time = formatTime(notice.scheduledAt);
  if (notice.status === "started") {
    return { title: "Scheduled task started", body: `${name} at ${time}`, tone: "success" };
  }
  return { title: "Scheduled task skipped", body: `${name} at ${time} (missed)`, tone: "warning" };
}

export function noticeKey(notice: CalendarRunNotice): string {
  return calendarRunNoticeKey(notice);
}

export interface CalendarNoticeCard {
  readonly key: string;
  readonly name: string;
  readonly status: CalendarRunNoticeStatus;
  readonly statusLabel: string;
  readonly scheduledAt: string;
  readonly observedAt: string;
  readonly unread: boolean;
}

/** One notice prepared for the list page; `unread` is the device's read cursor. */
export function toCalendarNoticeCard(
  notice: CalendarRunNotice,
  unread: boolean,
): CalendarNoticeCard {
  return {
    key: noticeKey(notice),
    name: notice.name,
    status: notice.status,
    statusLabel: notice.status === "started" ? "Started" : "Skipped (missed)",
    scheduledAt: notice.scheduledAt,
    observedAt: notice.observedAt,
    unread,
  };
}
