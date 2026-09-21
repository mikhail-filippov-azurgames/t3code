/**
 * Scheduled calendar events.
 *
 * An event fires a human-prepared message into a thread on a local-time
 * schedule. Repeats are stored as a 5-field cron expression interpreted in an
 * explicit IANA time zone; the server persists the next absolute fire instant
 * so no scheduler dependency is needed.
 *
 * @module calendar
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export const CalendarEventId = TrimmedNonEmptyString.pipe(Schema.brand("CalendarEventId"));
export type CalendarEventId = typeof CalendarEventId.Type;

/**
 * `new-thread` starts a brand-new thread on every fire. `continue` creates the
 * thread on the first fire and reuses the persisted event-to-thread mapping on
 * later fires.
 */
export const CalendarEventMode = Schema.Literals(["new-thread", "continue"]);
export type CalendarEventMode = typeof CalendarEventMode.Type;

/**
 * Five whitespace-separated fields `minute hour day-of-month month day-of-week`
 * in local wall-clock time. Supported tokens per field: a wildcard, a number, a
 * range, a stepped range or wildcard, a bare `n/step` that runs from `n` through
 * the field's maximum, and comma lists of those. `day-of-week` accepts 0-7 with
 * both 0 and 7 meaning Sunday.
 */
export const CalendarCronExpression = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export type CalendarCronExpression = typeof CalendarCronExpression.Type;

/** Search window for the next matching slot: eight years of calendar days. */
export const CALENDAR_CRON_LOOKAHEAD_DAYS = 366 * 8;

export interface CalendarCronField {
  readonly values: ReadonlySet<number>;
  readonly restricted: boolean;
}

export interface ParsedCalendarCron {
  readonly minute: CalendarCronField;
  readonly hour: CalendarCronField;
  readonly dayOfMonth: CalendarCronField;
  readonly month: CalendarCronField;
  readonly dayOfWeek: CalendarCronField;
}

function parseCalendarCronField(raw: string, min: number, max: number): CalendarCronField | null {
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
        // `n/step` runs from n through the field's maximum.
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

/**
 * Parse the five-field local-time cron the contract stores. Canonical for both
 * the server's time-zone-aware scheduler and the client's local wall clock;
 * `null` when the expression is invalid.
 */
export function parseCalendarCron(expression: string): ParsedCalendarCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCalendarCronField(fields[0]!, 0, 59);
  const hour = parseCalendarCronField(fields[1]!, 0, 23);
  const dayOfMonth = parseCalendarCronField(fields[2]!, 1, 31);
  const month = parseCalendarCronField(fields[3]!, 1, 12);
  const dayOfWeek = parseCalendarCronField(fields[4]!, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function calendarCronSortedValues(field: CalendarCronField): ReadonlyArray<number> {
  return [...field.values].sort((left, right) => left - right);
}

export function calendarCronMatchesDay(
  parsed: ParsedCalendarCron,
  dayOfMonth: number,
  dayOfWeek: number,
): boolean {
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(dayOfWeek);
  // Standard cron: when both day fields are restricted, either may match.
  if (parsed.dayOfMonth.restricted && parsed.dayOfWeek.restricted) {
    return dayOfMonthMatch || dayOfWeekMatch;
  }
  if (parsed.dayOfMonth.restricted) return dayOfMonthMatch;
  if (parsed.dayOfWeek.restricted) return dayOfWeekMatch;
  return true;
}

/** Max characters of an event name carried into run notifications. */
export const CALENDAR_NAME_LIMIT = 60;

/**
 * Shorten an event name for the notification channel, mirroring the
 * `truncateDetail` shape used for thread-completion notices. The result is
 * never longer than `limit`.
 */
export function calendarNameExcerpt(value: string, limit = CALENDAR_NAME_LIMIT): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
}

export const CalendarEvent = Schema.Struct({
  eventId: CalendarEventId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  message: Schema.String,
  mode: CalendarEventMode,
  cronExpression: CalendarCronExpression,
  timeZone: TrimmedNonEmptyString,
  nextFireAt: IsoDateTime,
  lastFiredAt: Schema.NullOr(IsoDateTime),
  lastMissedAt: Schema.NullOr(IsoDateTime),
  threadId: Schema.NullOr(ThreadId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CalendarEvent = typeof CalendarEvent.Type;

export const CalendarRunNoticeStatus = Schema.Literals(["started", "skipped-missed"]);
export type CalendarRunNoticeStatus = typeof CalendarRunNoticeStatus.Type;

/**
 * One run notification. `threadId` is absent for a `new-thread` event that was
 * skipped before its thread existed, so consumers must not rely on it.
 */
export const CalendarRunNotice = Schema.Struct({
  version: Schema.Literal(1),
  eventId: CalendarEventId,
  status: CalendarRunNoticeStatus,
  scheduledAt: IsoDateTime,
  observedAt: IsoDateTime,
  name: Schema.String.check(Schema.isMaxLength(CALENDAR_NAME_LIMIT)),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type CalendarRunNotice = typeof CalendarRunNotice.Type;

/**
 * Stable identity of one run notification. Two notices with the same key
 * describe the same run, so a redelivered snapshot never duplicates a card.
 */
export function calendarRunNoticeKey(notice: CalendarRunNotice): string {
  return `${notice.eventId}:${notice.status}:${notice.scheduledAt}`;
}

export const CalendarListInput = Schema.Struct({});
export type CalendarListInput = typeof CalendarListInput.Type;

export const CalendarListResult = Schema.Struct({
  events: Schema.Array(CalendarEvent),
});
export type CalendarListResult = typeof CalendarListResult.Type;

export const CalendarSubscribeNoticesInput = Schema.Struct({});
export type CalendarSubscribeNoticesInput = typeof CalendarSubscribeNoticesInput.Type;

/** Full run-notice list, newest first; the stream sends the whole list on every change. */
export const CalendarNoticesResult = Schema.Struct({
  notices: Schema.Array(CalendarRunNotice),
});
export type CalendarNoticesResult = typeof CalendarNoticesResult.Type;

export const CalendarCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  message: Schema.String,
  mode: CalendarEventMode,
  cronExpression: CalendarCronExpression,
  timeZone: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
});
export type CalendarCreateInput = typeof CalendarCreateInput.Type;

export const CalendarCreateResult = CalendarEvent;
export type CalendarCreateResult = typeof CalendarCreateResult.Type;

/**
 * Replaces an event's editable fields. `projectId` and the run history
 * (`lastFiredAt`, `lastMissedAt`, `threadId`, `createdAt`) are not part of the
 * update; the server keeps them. A changed `cronExpression` or `timeZone`
 * recomputes `nextFireAt` from now.
 */
export const CalendarUpdateInput = Schema.Struct({
  eventId: CalendarEventId,
  title: TrimmedNonEmptyString,
  message: Schema.String,
  mode: CalendarEventMode,
  cronExpression: CalendarCronExpression,
  timeZone: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type CalendarUpdateInput = typeof CalendarUpdateInput.Type;

export const CalendarUpdateResult = CalendarEvent;
export type CalendarUpdateResult = typeof CalendarUpdateResult.Type;

export const CalendarDeleteInput = Schema.Struct({
  eventId: CalendarEventId,
});
export type CalendarDeleteInput = typeof CalendarDeleteInput.Type;

export const CalendarDeleteResult = Schema.Struct({});
export type CalendarDeleteResult = typeof CalendarDeleteResult.Type;

export class CalendarError extends Schema.TaggedError<CalendarError>()("CalendarError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}
