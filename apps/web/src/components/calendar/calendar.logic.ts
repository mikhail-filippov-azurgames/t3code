/**
 * Pure calendar math and copy for the schedule view.
 *
 * The server owns the next absolute fire instant; the client only needs to
 * place occurrences on the visible grid and derive an optimistic next fire for
 * an event created before the calendar RPCs are wired. Repeats are the same
 * five-field cron the contract stores, read in local wall-clock time.
 *
 * @module components/calendar/calendar.logic
 */
import {
  calendarNameExcerpt,
  type CalendarEvent,
  type CalendarEventMode,
  type CalendarRunNotice,
} from "@t3tools/contracts";

export type CalendarRepeat = "daily" | "weekly" | "monthly" | "yearly" | "custom";

export const CALENDAR_REPEAT_OPTIONS: ReadonlyArray<{
  readonly value: CalendarRepeat;
  readonly label: string;
}> = [
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

interface CronFieldSet {
  readonly values: ReadonlySet<number>;
  readonly restricted: boolean;
}

export interface ParsedCron {
  readonly minutes: CronFieldSet;
  readonly hours: CronFieldSet;
  readonly daysOfMonth: CronFieldSet;
  readonly months: CronFieldSet;
  readonly daysOfWeek: CronFieldSet;
}

function parseField(raw: string, min: number, max: number): CronFieldSet | null {
  const field = raw.trim();
  if (field.length === 0) return null;
  const restricted = field !== "*";
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0 || rangePart === undefined || rangePart.length === 0) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let from = min;
    let to = max;
    if (rangePart !== "*") {
      const [startPart, endPart, ...rangeRest] = rangePart.split("-");
      if (rangeRest.length > 0 || startPart === undefined || startPart.length === 0) return null;
      // The contract allows a stepped range or a stepped wildcard, not a bare
      // `n/step`, and the server reads that shape differently from a single value.
      if (endPart === undefined && stepPart !== undefined) return null;
      from = Number(startPart);
      to = endPart === undefined ? from : Number(endPart);
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (values.size === 0) return null;
  return { values, restricted };
}

export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minuteRaw, 0, 59);
  const hours = parseField(hourRaw, 0, 23);
  const daysOfMonth = parseField(dayRaw, 1, 31);
  const months = parseField(monthRaw, 1, 12);
  const week = parseField(weekRaw, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !week) return null;

  // Both 0 and 7 mean Sunday, so the set is normalised down to 0-6.
  const daysOfWeek = new Set<number>();
  for (const value of week.values) daysOfWeek.add(value === 7 ? 0 : value);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: { values: daysOfWeek, restricted: week.restricted },
  };
}

/**
 * Standard cron day rule: a restricted day-of-month and day-of-week are ORed,
 * while a `*` field leaves the other one in charge.
 */
export function cronMatchesDay(cron: ParsedCron, date: Date): boolean {
  if (!cron.months.values.has(date.getMonth() + 1)) return false;
  const dayMatch = cron.daysOfMonth.values.has(date.getDate());
  const weekMatch = cron.daysOfWeek.values.has(date.getDay());
  if (cron.daysOfMonth.restricted && cron.daysOfWeek.restricted) return dayMatch || weekMatch;
  if (cron.daysOfMonth.restricted) return dayMatch;
  if (cron.daysOfWeek.restricted) return weekMatch;
  return true;
}

function sortedValues(values: ReadonlySet<number>): ReadonlyArray<number> {
  return [...values].toSorted((left, right) => left - right);
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

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatDayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Compose the cron the form's chosen start instant and repeat imply. */
export function composeCron(date: Date, repeat: CalendarRepeat, custom = ""): string {
  const minute = date.getMinutes();
  const hour = date.getHours();
  switch (repeat) {
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
  const hours = sortedValues(cron.hours.values);
  const minutes = sortedValues(cron.minutes.values);
  const occurrences: Date[] = [];
  for (let day = startOfDay(rangeStart); day.getTime() < rangeEnd.getTime(); day = addDays(day, 1)) {
    if (!cronMatchesDay(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (candidate.getTime() >= rangeStart.getTime() && candidate.getTime() < rangeEnd.getTime()) {
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
  const hours = sortedValues(cron.hours.values);
  const minutes = sortedValues(cron.minutes.values);
  const start = new Date(from);
  start.setSeconds(0, 0);
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = addDays(startOfDay(start), offset);
    if (!cronMatchesDay(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
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
  return `${notice.eventId}:${notice.status}:${notice.scheduledAt}`;
}
