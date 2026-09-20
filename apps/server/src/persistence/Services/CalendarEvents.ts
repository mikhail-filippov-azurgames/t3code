/**
 * CalendarEventRepository - local persistence for scheduled calendar events.
 *
 * Events are not part of the orchestration event log: they are a local store
 * read and advanced by the calendar reactor. This module keeps the interface
 * and the SQLite `Live` implementation together because the persistence
 * `Layers/` directory is outside this change's scope.
 *
 * @module CalendarEventRepository
 */
import {
  CalendarEvent,
  CalendarEventId,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../Errors.ts";

export const GetCalendarEventInput = Schema.Struct({ eventId: CalendarEventId });
export type GetCalendarEventInput = typeof GetCalendarEventInput.Type;

export const ListDueCalendarEventsInput = Schema.Struct({
  nowIso: IsoDateTime,
  limit: NonNegativeInt,
});
export type ListDueCalendarEventsInput = typeof ListDueCalendarEventsInput.Type;

export const RecordCalendarFireInput = Schema.Struct({
  eventId: CalendarEventId,
  firedAt: IsoDateTime,
  nextFireAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RecordCalendarFireInput = typeof RecordCalendarFireInput.Type;

export const RecordCalendarMissInput = Schema.Struct({
  eventId: CalendarEventId,
  missedAt: IsoDateTime,
  nextFireAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RecordCalendarMissInput = typeof RecordCalendarMissInput.Type;

export const SetCalendarEventThreadInput = Schema.Struct({
  eventId: CalendarEventId,
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});
export type SetCalendarEventThreadInput = typeof SetCalendarEventThreadInput.Type;

export const DeleteCalendarEventInput = Schema.Struct({ eventId: CalendarEventId });
export type DeleteCalendarEventInput = typeof DeleteCalendarEventInput.Type;

export interface CalendarEventRepositoryShape {
  readonly create: (event: CalendarEvent) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetCalendarEventInput,
  ) => Effect.Effect<Option.Option<CalendarEvent>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<CalendarEvent>, ProjectionRepositoryError>;
  readonly listDue: (
    input: ListDueCalendarEventsInput,
  ) => Effect.Effect<ReadonlyArray<CalendarEvent>, ProjectionRepositoryError>;
  /** Persist a successful fire and the next absolute fire instant. */
  readonly recordFire: (input: RecordCalendarFireInput) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Persist a skipped (missed) slot and the next absolute fire instant. */
  readonly recordMissed: (
    input: RecordCalendarMissInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Persist the continue-mode event-to-thread mapping. */
  readonly setThreadId: (
    input: SetCalendarEventThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteCalendarEventInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class CalendarEventRepository extends Context.Service<
  CalendarEventRepository,
  CalendarEventRepositoryShape
>()("t3/persistence/Services/CalendarEvents/CalendarEventRepository") {}

const CalendarEventDbRow = CalendarEvent.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
type CalendarEventDbRow = typeof CalendarEventDbRow.Type;

const makeCalendarEventRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertCalendarEventRow = SqlSchema.void({
    Request: CalendarEvent,
    execute: (row) =>
      sql`
        INSERT INTO calendar_events (
          event_id,
          project_id,
          title,
          message,
          mode,
          cron_expression,
          time_zone,
          next_fire_at,
          last_fired_at,
          last_missed_at,
          thread_id,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        )
        VALUES (
          ${row.eventId},
          ${row.projectId},
          ${row.title},
          ${row.message},
          ${row.mode},
          ${row.cronExpression},
          ${row.timeZone},
          ${row.nextFireAt},
          ${row.lastFiredAt},
          ${row.lastMissedAt},
          ${row.threadId},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (event_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          message = excluded.message,
          mode = excluded.mode,
          cron_expression = excluded.cron_expression,
          time_zone = excluded.time_zone,
          next_fire_at = excluded.next_fire_at,
          last_fired_at = excluded.last_fired_at,
          last_missed_at = excluded.last_missed_at,
          thread_id = excluded.thread_id,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getCalendarEventRow = SqlSchema.findOneOption({
    Request: GetCalendarEventInput,
    Result: CalendarEventDbRow,
    execute: ({ eventId }) =>
      sql`
        SELECT
          event_id AS "eventId",
          project_id AS "projectId",
          title,
          message,
          mode,
          cron_expression AS "cronExpression",
          time_zone AS "timeZone",
          next_fire_at AS "nextFireAt",
          last_fired_at AS "lastFiredAt",
          last_missed_at AS "lastMissedAt",
          thread_id AS "threadId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM calendar_events
        WHERE event_id = ${eventId}
      `,
  });

  const listCalendarEventRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CalendarEventDbRow,
    execute: () =>
      sql`
        SELECT
          event_id AS "eventId",
          project_id AS "projectId",
          title,
          message,
          mode,
          cron_expression AS "cronExpression",
          time_zone AS "timeZone",
          next_fire_at AS "nextFireAt",
          last_fired_at AS "lastFiredAt",
          last_missed_at AS "lastMissedAt",
          thread_id AS "threadId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM calendar_events
        ORDER BY next_fire_at ASC, event_id ASC
      `,
  });

  const listDueCalendarEventRows = SqlSchema.findAll({
    Request: ListDueCalendarEventsInput,
    Result: CalendarEventDbRow,
    execute: ({ nowIso, limit }) =>
      sql`
        SELECT
          event_id AS "eventId",
          project_id AS "projectId",
          title,
          message,
          mode,
          cron_expression AS "cronExpression",
          time_zone AS "timeZone",
          next_fire_at AS "nextFireAt",
          last_fired_at AS "lastFiredAt",
          last_missed_at AS "lastMissedAt",
          thread_id AS "threadId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM calendar_events
        WHERE next_fire_at <= ${nowIso}
        ORDER BY next_fire_at ASC, event_id ASC
        LIMIT ${limit}
      `,
  });

  const recordCalendarFireRow = SqlSchema.void({
    Request: RecordCalendarFireInput,
    execute: ({ eventId, firedAt, nextFireAt, updatedAt }) =>
      sql`
        UPDATE calendar_events
        SET last_fired_at = ${firedAt},
            next_fire_at = ${nextFireAt},
            updated_at = ${updatedAt}
        WHERE event_id = ${eventId}
      `,
  });

  const recordCalendarMissRow = SqlSchema.void({
    Request: RecordCalendarMissInput,
    execute: ({ eventId, missedAt, nextFireAt, updatedAt }) =>
      sql`
        UPDATE calendar_events
        SET last_missed_at = ${missedAt},
            next_fire_at = ${nextFireAt},
            updated_at = ${updatedAt}
        WHERE event_id = ${eventId}
      `,
  });

  const setCalendarEventThreadRow = SqlSchema.void({
    Request: SetCalendarEventThreadInput,
    execute: ({ eventId, threadId, updatedAt }) =>
      sql`
        UPDATE calendar_events
        SET thread_id = ${threadId},
            updated_at = ${updatedAt}
        WHERE event_id = ${eventId}
      `,
  });

  const deleteCalendarEventRow = SqlSchema.void({
    Request: DeleteCalendarEventInput,
    execute: ({ eventId }) =>
      sql`
        DELETE FROM calendar_events
        WHERE event_id = ${eventId}
      `,
  });

  const create: CalendarEventRepositoryShape["create"] = (event) =>
    insertCalendarEventRow(event).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.create:query")),
    );

  const getById: CalendarEventRepositoryShape["getById"] = (input) =>
    getCalendarEventRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.getById:query")),
    );

  const listAll: CalendarEventRepositoryShape["listAll"] = () =>
    listCalendarEventRows().pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.listAll:query")),
    );

  const listDue: CalendarEventRepositoryShape["listDue"] = (input) =>
    listDueCalendarEventRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.listDue:query")),
    );

  const recordFire: CalendarEventRepositoryShape["recordFire"] = (input) =>
    recordCalendarFireRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.recordFire:query")),
    );

  const recordMissed: CalendarEventRepositoryShape["recordMissed"] = (input) =>
    recordCalendarMissRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.recordMissed:query")),
    );

  const setThreadId: CalendarEventRepositoryShape["setThreadId"] = (input) =>
    setCalendarEventThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.setThreadId:query")),
    );

  const deleteById: CalendarEventRepositoryShape["deleteById"] = (input) =>
    deleteCalendarEventRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CalendarEventRepository.deleteById:query")),
    );

  return {
    create,
    getById,
    listAll,
    listDue,
    recordFire,
    recordMissed,
    setThreadId,
    deleteById,
  } satisfies CalendarEventRepositoryShape;
});

export const CalendarEventRepositoryLive = Layer.effect(
  CalendarEventRepository,
  makeCalendarEventRepository,
);
