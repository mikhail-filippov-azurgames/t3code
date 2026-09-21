/**
 * Calendar event cache for the web client.
 *
 * The server owns calendar events. `useCalendarBackend` fills this store from
 * `calendar.list` and flips `transport` to `live`; while the server is
 * unreachable the store keeps whatever it last received and reports the failure
 * through `error`. There is no local-only write path: an event this browser
 * invented could never fire on the server.
 *
 * @module state/calendar
 */
import { type CalendarEvent, type CalendarRunNotice, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { create } from "zustand";

export type CalendarTransport = "offline" | "live";

/**
 * The most specific sentence available for a failed calendar RPC. `CalendarError`
 * carries its reason in `detail` and leaves `message` empty, so message-first is
 * not enough.
 */
export function calendarFailureText(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.trim().length > 0
  ) {
    return error.detail;
  }
  return "The calendar server rejected the request.";
}

/** A run notice plus the environment whose server posted it. */
export interface CalendarRunNoticeEnvelope {
  readonly environmentId: EnvironmentId;
  readonly notice: CalendarRunNotice;
}

export interface CalendarStoreState {
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly notices: ReadonlyArray<CalendarRunNoticeEnvelope>;
  readonly transport: CalendarTransport;
  readonly error: string | null;
  readonly setTransport: (transport: CalendarTransport) => void;
  readonly setError: (error: string | null) => void;
  readonly replaceEvents: (events: ReadonlyArray<CalendarEvent>) => void;
  readonly upsertEvent: (event: CalendarEvent) => void;
  readonly removeEvent: (eventId: string) => void;
  readonly pushNotice: (envelope: CalendarRunNoticeEnvelope) => void;
  readonly dismissNotice: (key: string) => void;
}

export const useCalendarStore = create<CalendarStoreState>((set) => ({
  events: [],
  notices: [],
  transport: "offline",
  error: null,
  setTransport: (transport) => set({ transport }),
  setError: (error) => set({ error }),
  replaceEvents: (events) => set({ events }),
  // Server refreshes land before or after the command reply; replacing by id
  // keeps an optimistic insert from doubling up on the same event.
  upsertEvent: (event) =>
    set((state) => {
      const index = state.events.findIndex((candidate) => candidate.eventId === event.eventId);
      if (index === -1) {
        return { events: [...state.events, event] };
      }
      const events = [...state.events];
      events[index] = event;
      return { events };
    }),
  removeEvent: (eventId) =>
    set((state) => ({
      events: state.events.filter((event) => (event.eventId as string) !== eventId),
    })),
  pushNotice: (envelope) => set((state) => ({ notices: [...state.notices, envelope] })),
  dismissNotice: (key) =>
    set((state) => ({
      notices: state.notices.filter(
        ({ notice }) => `${notice.eventId}:${notice.status}:${notice.scheduledAt}` !== key,
      ),
    })),
}));
