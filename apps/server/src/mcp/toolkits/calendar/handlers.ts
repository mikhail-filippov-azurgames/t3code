import { type CalendarEvent, CalendarError, CalendarEventId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  assessCalendarEventUpdateCadence,
  assessCalendarNewThreadCadence,
  nextCalendarFireAt,
  planCalendarEventUpdate,
} from "../../../background/CalendarReactor.ts";
import * as CalendarEvents from "../../../persistence/Services/CalendarEvents.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CalendarToolkit } from "./tools.ts";

/**
 * Mirrors the `calendar.*` RPC authorization: reads and writes both sit behind
 * the orchestration scope, which every agent MCP credential already carries, so
 * the toolkit adds no capability of its own.
 */
const requireCalendarAccess = McpInvocationContext.requireMcpCapability("orchestration");

const toCalendarError = (operation: string, cause: unknown) =>
  new CalendarError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const make = Effect.gen(function* () {
  const repository = yield* CalendarEvents.CalendarEventRepository;
  const crypto = yield* Crypto.Crypto;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  return CalendarToolkit.of({
    calendar_list: () =>
      Effect.gen(function* () {
        yield* requireCalendarAccess;
        const events = yield* repository
          .listAll()
          .pipe(Effect.mapError((cause) => toCalendarError("calendar.list", cause)));
        return { events };
      }),
    calendar_create: (input) =>
      Effect.gen(function* () {
        yield* requireCalendarAccess;
        const createdAt = yield* nowIso;
        const nextFireAt = nextCalendarFireAt(input.cronExpression, input.timeZone, createdAt);
        if (nextFireAt === null) {
          return yield* new CalendarError({
            operation: "calendar.create",
            detail: "Cron expression has no upcoming fire time.",
          });
        }
        const cadence = assessCalendarNewThreadCadence(
          input.mode,
          input.cronExpression,
          input.timeZone,
          createdAt,
        );
        if (cadence.forbiddenDetail !== null) {
          return yield* new CalendarError({
            operation: "calendar.create",
            detail: cadence.forbiddenDetail,
          });
        }
        const event: CalendarEvent = {
          eventId: CalendarEventId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          projectId: input.projectId,
          title: input.title,
          message: input.message,
          mode: input.mode,
          cronExpression: input.cronExpression,
          timeZone: input.timeZone,
          nextFireAt,
          lastFiredAt: null,
          lastMissedAt: null,
          threadId: null,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt,
          updatedAt: createdAt,
        };
        yield* repository
          .create(event)
          .pipe(Effect.mapError((cause) => toCalendarError("calendar.create", cause)));
        return cadence.warning === null ? event : { ...event, warning: cadence.warning };
      }),
    calendar_update: (input) =>
      Effect.gen(function* () {
        yield* requireCalendarAccess;
        const current = yield* repository
          .getById({ eventId: input.eventId })
          .pipe(Effect.mapError((cause) => toCalendarError("calendar.update", cause)));
        if (Option.isNone(current)) {
          return yield* new CalendarError({
            operation: "calendar.update",
            detail: "Calendar event not found.",
          });
        }
        const updatedAt = yield* nowIso;
        const updated = planCalendarEventUpdate(current.value, input, updatedAt);
        if (updated === null) {
          return yield* new CalendarError({
            operation: "calendar.update",
            detail: "Cron expression has no upcoming fire time.",
          });
        }
        const cadence = assessCalendarEventUpdateCadence(current.value, input, updatedAt);
        if (cadence.forbiddenDetail !== null) {
          return yield* new CalendarError({
            operation: "calendar.update",
            detail: cadence.forbiddenDetail,
          });
        }
        yield* repository
          .update(updated)
          .pipe(Effect.mapError((cause) => toCalendarError("calendar.update", cause)));
        return cadence.warning === null ? updated : { ...updated, warning: cadence.warning };
      }),
    calendar_delete: (input) =>
      Effect.gen(function* () {
        yield* requireCalendarAccess;
        yield* repository.deleteById({ eventId: input.eventId }).pipe(
          Effect.as({}),
          Effect.mapError((cause) => toCalendarError("calendar.delete", cause)),
        );
        return {};
      }),
  });
});

export const CalendarToolkitHandlersLive = CalendarToolkit.toLayer(make);
