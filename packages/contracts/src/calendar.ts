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

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
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
 * range, a stepped range or wildcard, and comma lists of those. `day-of-week`
 * accepts 0-7 with both 0 and 7 meaning Sunday.
 */
export const CalendarCronExpression = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export type CalendarCronExpression = typeof CalendarCronExpression.Type;

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

/** Payload posted to the thread-completion notification channel. */
export const CalendarRunNotice = Schema.Struct({
  version: Schema.Literal(1),
  eventId: CalendarEventId,
  status: CalendarRunNoticeStatus,
  scheduledAt: IsoDateTime,
  observedAt: IsoDateTime,
  name: Schema.String.check(Schema.isMaxLength(CALENDAR_NAME_LIMIT)),
});
export type CalendarRunNotice = typeof CalendarRunNotice.Type;

export const CalendarListInput = Schema.Struct({});
export type CalendarListInput = typeof CalendarListInput.Type;

export const CalendarListResult = Schema.Struct({
  events: Schema.Array(CalendarEvent),
});
export type CalendarListResult = typeof CalendarListResult.Type;

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
