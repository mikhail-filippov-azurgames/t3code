/**
 * Client-side calendar state.
 *
 * `calendar.list` / `calendar.create` / `calendar.delete` are defined in
 * `@t3tools/contracts` but are not members of `WsRpcGroup` yet, so the app has
 * no generated atom or command for them. Until that server wiring lands this
 * store is the only source of events: a created event is kept locally and
 * marked `localOnlyEventIds` so the grid can label it as not saved. When the
 * RPCs are wired, the transport flips to `live`, `replaceEvents` takes the
 * server list, and the local-only path can be deleted.
 *
 * @module state/calendar
 */
import {
  CalendarEventId,
  type CalendarCreateInput,
  type CalendarEvent,
  type CalendarRunNotice,
  type EnvironmentId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { nextCronOccurrence } from "../components/calendar/calendar.logic";
import { randomUUID } from "../lib/utils";

export type CalendarTransport = "unwired" | "live";

/** A run notice plus the environment whose server posted it. */
export interface CalendarRunNoticeEnvelope {
  readonly environmentId: EnvironmentId;
  readonly notice: CalendarRunNotice;
}

export interface CalendarStoreState {
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly localOnlyEventIds: ReadonlySet<string>;
  readonly notices: ReadonlyArray<CalendarRunNoticeEnvelope>;
  readonly transport: CalendarTransport;
  readonly error: string | null;
  readonly setTransport: (transport: CalendarTransport) => void;
  readonly setError: (error: string | null) => void;
  readonly replaceEvents: (events: ReadonlyArray<CalendarEvent>) => void;
  readonly removeEvent: (eventId: string) => void;
  readonly createLocalEvent: (input: CalendarCreateInput) => CalendarEvent;
  readonly pushNotice: (envelope: CalendarRunNoticeEnvelope) => void;
  readonly dismissNotice: (key: string) => void;
}

export function buildCalendarEvent(input: CalendarCreateInput, now: Date): CalendarEvent {
  const iso = now.toISOString();
  const nextFire = nextCronOccurrence(input.cronExpression, now) ?? now;
  return {
    eventId: CalendarEventId.make(randomUUID()),
    projectId: input.projectId,
    title: input.title,
    message: input.message,
    mode: input.mode,
    cronExpression: input.cronExpression,
    timeZone: input.timeZone,
    nextFireAt: nextFire.toISOString(),
    lastFiredAt: null,
    lastMissedAt: null,
    threadId: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: iso,
    updatedAt: iso,
  };
}

export const useCalendarStore = create<CalendarStoreState>((set) => ({
  events: [],
  localOnlyEventIds: new Set(),
  notices: [],
  transport: "unwired",
  error: null,
  setTransport: (transport) => set({ transport }),
  setError: (error) => set({ error }),
  replaceEvents: (events) =>
    set((state) => {
      const serverIds = new Set(events.map((event) => event.eventId as string));
      const keptLocal = state.events.filter(
        (event) =>
          state.localOnlyEventIds.has(event.eventId as string) &&
          !serverIds.has(event.eventId as string),
      );
      const keptLocalIds = new Set(keptLocal.map((event) => event.eventId as string));
      return {
        events: [...events, ...keptLocal],
        localOnlyEventIds: keptLocalIds,
      };
    }),
  removeEvent: (eventId) =>
    set((state) => {
      const localOnlyEventIds = new Set(state.localOnlyEventIds);
      localOnlyEventIds.delete(eventId);
      return {
        events: state.events.filter((event) => (event.eventId as string) !== eventId),
        localOnlyEventIds,
      };
    }),
  createLocalEvent: (input) => {
    const event = buildCalendarEvent(input, new Date());
    set((state) => {
      const localOnlyEventIds = new Set(state.localOnlyEventIds);
      localOnlyEventIds.add(event.eventId as string);
      return { events: [...state.events, event], localOnlyEventIds };
    });
    return event;
  },
  pushNotice: (envelope) =>
    set((state) => ({ notices: [...state.notices, envelope] })),
  dismissNotice: (key) =>
    set((state) => ({
      notices: state.notices.filter(
        ({ notice }) => `${notice.eventId}:${notice.status}:${notice.scheduledAt}` !== key,
      ),
    })),
}));
