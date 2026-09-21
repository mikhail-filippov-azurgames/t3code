/**
 * Device-local notification inbox.
 *
 * The inbox unifies every notice the client can observe: calendar run notices
 * arrive on the server stream, and thread events are derived from shell
 * transitions. There is no server read cursor or history, so read state and
 * durability belong to this browser. Each entry expires 24 hours after it was
 * observed, whether it came from the server or a local transition.
 *
 * @module state/notifications
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

export type AppNoticeKind = "calendar" | "thread-completed" | "error" | "other";

export interface AppNotice {
  /** Stable identity; a redelivered or repeated event must not duplicate a row. */
  readonly key: string;
  readonly kind: AppNoticeKind;
  readonly title: string;
  readonly body: string | null;
  /** Instant the notice describes, used for ordering and retention. */
  readonly at: string;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

/** Entries live this long after `at`; the boundary instant itself is expired. */
export const NOTICE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Sweep cadence for the retention timer mounted by {@link useNoticeRetention}. */
export const NOTICE_PURGE_INTERVAL_MS = 60 * 60 * 1000;

const INBOX_KEY = "t3code.notifications.inbox.v1";

const APP_NOTICE_KINDS: ReadonlySet<string> = new Set([
  "calendar",
  "thread-completed",
  "error",
  "other",
]);

export function isNoticeExpired(notice: AppNotice, now: number): boolean {
  const at = Date.parse(notice.at);
  if (!Number.isFinite(at)) return true;
  return now - at >= NOTICE_RETENTION_MS;
}

function compareInstantsDesc(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return rightMs - leftMs;
  return right < left ? 1 : right > left ? -1 : 0;
}

/** Newest first; ties fall back to the key so ordering is stable across reloads. */
export function sortNoticesNewestFirst(notices: ReadonlyArray<AppNotice>): AppNotice[] {
  return [...notices].sort((left, right) => {
    const order = compareInstantsDesc(left.at, right.at);
    if (order !== 0) return order;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}

/** Whether a notice is newer than the device's read cursor; null means everything. */
export function isNoticeUnread(notice: AppNotice, lastReadAt: string | null): boolean {
  if (lastReadAt === null) return true;
  const at = Date.parse(notice.at);
  if (!Number.isFinite(at)) return false;
  const read = Date.parse(lastReadAt);
  if (!Number.isFinite(read)) return true;
  return at > read;
}

export interface NoticeInbox {
  readonly notices: ReadonlyArray<AppNotice>;
  readonly lastReadAt: string | null;
}

export function selectUnreadNoticeCount(state: NoticeInbox): number {
  let count = 0;
  for (const notice of state.notices) {
    if (isNoticeUnread(notice, state.lastReadAt)) count += 1;
  }
  return count;
}

function isAppNotice(value: unknown): value is AppNotice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.kind === "string" &&
    APP_NOTICE_KINDS.has(candidate.kind) &&
    typeof candidate.title === "string" &&
    typeof candidate.at === "string"
  );
}

interface PersistedInbox extends NoticeInbox {
  readonly version: 1;
}

/**
 * Reads the persisted inbox, dropping anything already past retention. Kept
 * separate from the store so tests can exercise rehydration without rebuilding
 * the module-level singleton.
 */
export function readPersistedInbox(): NoticeInbox {
  try {
    if (typeof localStorage === "undefined") return { notices: [], lastReadAt: null };
    const raw = localStorage.getItem(INBOX_KEY);
    if (raw === null) return { notices: [], lastReadAt: null };
    const parsed = JSON.parse(raw) as Partial<PersistedInbox>;
    const now = Date.now();
    const notices = Array.isArray(parsed.notices)
      ? parsed.notices.filter((notice): notice is AppNotice => isAppNotice(notice))
      : [];
    const lastReadAt = typeof parsed.lastReadAt === "string" ? parsed.lastReadAt : null;
    return {
      notices: sortNoticesNewestFirst(notices.filter((notice) => !isNoticeExpired(notice, now))),
      lastReadAt,
    };
  } catch {
    return { notices: [], lastReadAt: null };
  }
}

function writePersistedInbox(inbox: NoticeInbox): void {
  try {
    if (typeof localStorage === "undefined") return;
    const payload: PersistedInbox = {
      version: 1,
      notices: [...inbox.notices],
      lastReadAt: inbox.lastReadAt,
    };
    localStorage.setItem(INBOX_KEY, JSON.stringify(payload));
  } catch {
    // Private modes can reject storage; the inbox still works for this session.
  }
}

export interface NotificationsStoreState extends NoticeInbox {
  readonly appendNotice: (notice: AppNotice) => void;
  readonly mergeNotices: (notices: ReadonlyArray<AppNotice>) => void;
  readonly markAllRead: () => void;
  readonly purgeExpired: () => void;
}

export const useNotificationsStore = create<NotificationsStoreState>((set) => {
  const persisted = readPersistedInbox();
  return {
    notices: persisted.notices,
    lastReadAt: persisted.lastReadAt,
    appendNotice: (notice) =>
      set((state) => {
        const now = Date.now();
        if (isNoticeExpired(notice, now)) return state;
        const notices = sortNoticesNewestFirst([
          notice,
          ...state.notices.filter(
            (candidate) => candidate.key !== notice.key && !isNoticeExpired(candidate, now),
          ),
        ]);
        writePersistedInbox({ notices, lastReadAt: state.lastReadAt });
        return { notices };
      }),
    // A whole-list server snapshot replaces by key rather than appending, so a
    // reconnect never doubles the calendar notices already in the inbox.
    mergeNotices: (incoming) =>
      set((state) => {
        const now = Date.now();
        const byKey = new Map(
          state.notices
            .filter((notice) => !isNoticeExpired(notice, now))
            .map((notice) => [notice.key, notice] as const),
        );
        for (const notice of incoming) {
          if (!isNoticeExpired(notice, now)) byKey.set(notice.key, notice);
        }
        const notices = sortNoticesNewestFirst([...byKey.values()]);
        writePersistedInbox({ notices, lastReadAt: state.lastReadAt });
        return { notices };
      }),
    markAllRead: () =>
      set((state) => {
        // The cursor is the later of now and the newest notice instant, so it
        // never sits behind a notice already in the inbox.
        let lastReadMs = Date.now();
        for (const notice of state.notices) {
          const at = Date.parse(notice.at);
          if (Number.isFinite(at) && at > lastReadMs) lastReadMs = at;
        }
        const lastReadAt = new Date(lastReadMs).toISOString();
        writePersistedInbox({ notices: state.notices, lastReadAt });
        return { lastReadAt };
      }),
    purgeExpired: () =>
      set((state) => {
        const now = Date.now();
        const notices = state.notices.filter((notice) => !isNoticeExpired(notice, now));
        if (notices.length === state.notices.length) return state;
        writePersistedInbox({ notices, lastReadAt: state.lastReadAt });
        return { notices };
      }),
  };
});

export type ThreadNoticeEvent = "completed" | "failed" | "input" | "approval";

const THREAD_NOTICE_KIND: Record<ThreadNoticeEvent, AppNoticeKind> = {
  completed: "thread-completed",
  failed: "error",
  input: "other",
  approval: "other",
};

/** Builds the inbox entry for one observed thread event; `token` is the turn or status that fired it. */
export function threadNotice(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly event: ThreadNoticeEvent;
  readonly token: string | null;
  readonly at: string;
  readonly title: string;
  readonly body?: string | null;
}): AppNotice {
  return {
    key: `${input.environmentId}:${input.threadId}:${input.event}:${input.token ?? input.at}`,
    kind: THREAD_NOTICE_KIND[input.event],
    title: input.title,
    body: input.body ?? null,
    at: input.at,
    environmentId: input.environmentId,
    threadId: input.threadId,
  };
}

/** Mount once per app; purges on load and then on a slow timer while the app is open. */
export function useNoticeRetention(): void {
  useEffect(() => {
    useNotificationsStore.getState().purgeExpired();
    const timer = setInterval(
      () => useNotificationsStore.getState().purgeExpired(),
      NOTICE_PURGE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, []);
}
