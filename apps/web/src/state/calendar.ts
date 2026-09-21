/**
 * Calendar event and run-notice cache for the web client.
 *
 * The server owns calendar events. `useCalendarBackend` fills this store from
 * `calendar.list` and flips `transport` to `live`; while the server is
 * unreachable the store keeps whatever it last received and reports the failure
 * through `error`. There is no local-only write path: an event this browser
 * invented could never fire on the server.
 *
 * Run notices arrive through the `calendar.subscribeNotices` stream. Read and
 * notified state is device-local (localStorage): the server has no per-user
 * notice state, so each browser tracks what it has already seen.
 *
 * @module state/calendar
 */
import { type CalendarEvent, type CalendarRunNotice, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { create } from "zustand";

export type CalendarTransport = "offline" | "live";

const READ_AT_KEY = "t3code.calendar.notices.readAt";
const NOTIFIED_AT_KEY = "t3code.calendar.notices.notifiedAt";

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

function readStoredTimestamp(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredTimestamp(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private modes can reject storage; the counter simply resets next launch.
  }
}

/** ISO instants compare lexicographically, but parse for a stable fallback. */
function isAfter(left: string, right: string | null): boolean {
  if (right === null) return true;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return left > right;
  return leftMs > rightMs;
}

/** Newest observed instant across notices, or the prior value when there is none. */
function laterObservedAt(
  notices: ReadonlyArray<CalendarRunNoticeEnvelope>,
  prior: string | null,
): string | null {
  let newest: string | null = prior;
  for (const { notice } of notices) {
    if (newest === null || isAfter(notice.observedAt, newest)) newest = notice.observedAt;
  }
  return newest;
}

export interface CalendarStoreState {
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly notices: ReadonlyArray<CalendarRunNoticeEnvelope>;
  /** Device-local instant through which notices have been read. */
  readonly lastReadAt: string | null;
  /** Device-local instant through which notices have been shown as alerts. */
  readonly lastNotifiedAt: string | null;
  readonly transport: CalendarTransport;
  readonly error: string | null;
  readonly setTransport: (transport: CalendarTransport) => void;
  readonly setError: (error: string | null) => void;
  readonly replaceEvents: (events: ReadonlyArray<CalendarEvent>) => void;
  readonly upsertEvent: (event: CalendarEvent) => void;
  readonly removeEvent: (eventId: string) => void;
  readonly replaceNotices: (notices: ReadonlyArray<CalendarRunNoticeEnvelope>) => void;
  readonly markAllNoticesRead: () => void;
  readonly markNoticesNotified: () => void;
}

export const useCalendarStore = create<CalendarStoreState>((set) => ({
  events: [],
  notices: [],
  lastReadAt: readStoredTimestamp(READ_AT_KEY),
  lastNotifiedAt: readStoredTimestamp(NOTIFIED_AT_KEY),
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
  replaceNotices: (notices) => set({ notices }),
  markAllNoticesRead: () =>
    set((state) => {
      const lastReadAt = laterObservedAt(state.notices, state.lastReadAt);
      writeStoredTimestamp(READ_AT_KEY, lastReadAt);
      return { lastReadAt };
    }),
  markNoticesNotified: () =>
    set((state) => {
      const lastNotifiedAt = laterObservedAt(state.notices, state.lastNotifiedAt);
      writeStoredTimestamp(NOTIFIED_AT_KEY, lastNotifiedAt);
      return { lastNotifiedAt };
    }),
}));

/** Unread notices for the sidebar badge; every notice is unread before the first read. */
export function selectUnreadNoticeCount(state: CalendarStoreState): number {
  let count = 0;
  for (const { notice } of state.notices) {
    if (isNoticeUnread(notice, state.lastReadAt)) count += 1;
  }
  return count;
}

/** Notices for the page, newest first. Pure so callers can memoize the sort. */
export function sortNoticesNewestFirst(
  notices: ReadonlyArray<CalendarRunNoticeEnvelope>,
): ReadonlyArray<CalendarRunNoticeEnvelope> {
  return [...notices].sort((left, right) =>
    isAfter(left.notice.observedAt, right.notice.observedAt)
      ? -1
      : isAfter(right.notice.observedAt, left.notice.observedAt)
        ? 1
        : 0,
  );
}

/** Whether a notice is newer than the device's read cursor. */
export function isNoticeUnread(notice: CalendarRunNotice, lastReadAt: string | null): boolean {
  return isAfter(notice.observedAt, lastReadAt);
}
