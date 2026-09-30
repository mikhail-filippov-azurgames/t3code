import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MAX_ROUTINE_NOTICES,
  NOTICE_RETENTION_MS,
  ROUTINE_NOTICE_RETENTION_MS,
  isNoticeExpired,
  isNoticeUnread,
  readPersistedInbox,
  selectUnreadNoticeCount,
  sortNoticesNewestFirst,
  threadCompletedGroupKey,
  threadCompletedGroupNotice,
  threadNotice,
  useNotificationsStore,
  type AppNotice,
} from "./notifications";

const NOW = Date.parse("2026-01-05T12:00:00.000Z");

function notice(key: string, at: string, overrides: Partial<AppNotice> = {}): AppNotice {
  return {
    key,
    kind: "other",
    title: "Notice",
    body: null,
    at,
    environmentId: null,
    threadId: null,
    ...overrides,
  };
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(() => {
  useNotificationsStore.setState({ notices: [], lastReadAt: null });
  vi.unstubAllGlobals();
});

describe("notice retention", () => {
  it("keeps a fresh notice and expires one at or past 24 hours", () => {
    expect(isNoticeExpired(notice("fresh", new Date(NOW - 60_000).toISOString()), NOW)).toBe(false);
    expect(
      isNoticeExpired(notice("boundary", new Date(NOW - NOTICE_RETENTION_MS).toISOString()), NOW),
    ).toBe(true);
    expect(
      isNoticeExpired(notice("older", new Date(NOW - NOTICE_RETENTION_MS - 1).toISOString()), NOW),
    ).toBe(true);
  });

  it("treats an unparsable instant as expired", () => {
    expect(isNoticeExpired(notice("bad", "not-a-date"), NOW)).toBe(true);
  });

  it("purges expired rows and keeps fresh ones", () => {
    const fresh = notice("fresh", ago(1_000));
    const older = notice("older", ago(NOTICE_RETENTION_MS + 1_000));
    useNotificationsStore.setState({ notices: [fresh, older], lastReadAt: null });

    useNotificationsStore.getState().purgeExpired();

    expect(useNotificationsStore.getState().notices.map((entry) => entry.key)).toEqual(["fresh"]);
  });
});

describe("inbox append and dedup", () => {
  it("replaces a repeated key instead of duplicating it", () => {
    const at = ago(1_000);
    useNotificationsStore.getState().appendNotice(notice("k", at, { title: "First" }));
    useNotificationsStore.getState().appendNotice(notice("k", at, { title: "Second" }));

    const notices = useNotificationsStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Second");
  });

  it("drops an append that is already expired", () => {
    useNotificationsStore.getState().appendNotice(notice("old", ago(NOTICE_RETENTION_MS + 1_000)));
    expect(useNotificationsStore.getState().notices).toHaveLength(0);
  });
});

describe("calendar snapshot merge", () => {
  it("merges by key and skips expired server replays", () => {
    const fresh = notice("cal-a", ago(1_000));
    const stale = notice("cal-b", ago(NOTICE_RETENTION_MS + 1_000));

    useNotificationsStore.getState().mergeNotices([fresh, stale]);
    expect(useNotificationsStore.getState().notices.map((entry) => entry.key)).toEqual(["cal-a"]);

    useNotificationsStore.getState().mergeNotices([fresh, fresh]);
    expect(useNotificationsStore.getState().notices).toHaveLength(1);
  });
});

describe("inbox ordering and read cursor", () => {
  it("sorts newest first and counts everything before the first read", () => {
    const older = notice("a", "2026-01-05T08:00:00.000Z");
    const newer = notice("b", "2026-01-05T09:00:00.000Z");

    expect(sortNoticesNewestFirst([older, newer]).map((entry) => entry.key)).toEqual(["b", "a"]);
    expect(selectUnreadNoticeCount({ notices: [older, newer], lastReadAt: null })).toBe(2);
    expect(isNoticeUnread(older, "2026-01-05T08:30:00.000Z")).toBe(false);
    expect(isNoticeUnread(newer, "2026-01-05T08:30:00.000Z")).toBe(true);
  });

  it("clears the badge through now, never behind a notice instant", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-05T09:30:00.000Z"));
      useNotificationsStore.setState({
        notices: [notice("a", "2026-01-05T08:00:00.000Z"), notice("b", "2026-01-05T09:00:00.000Z")],
        lastReadAt: null,
      });

      useNotificationsStore.getState().markAllRead();

      expect(useNotificationsStore.getState().lastReadAt).toBe("2026-01-05T09:30:00.000Z");
      expect(selectUnreadNoticeCount(useNotificationsStore.getState())).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a future notice instant as the read cursor", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-05T09:30:00.000Z"));
      useNotificationsStore.setState({
        notices: [notice("future", "2026-01-05T12:00:00.000Z")],
        lastReadAt: null,
      });

      useNotificationsStore.getState().markAllRead();

      expect(useNotificationsStore.getState().lastReadAt).toBe("2026-01-05T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("threadNotice", () => {
  const base = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    token: "turn-1",
    at: "2026-01-05T09:00:00.000Z",
    title: "Thread completed",
  };

  it("maps each event to its kind", () => {
    expect(threadNotice({ ...base, event: "completed" }).kind).toBe("thread-completed");
    expect(threadNotice({ ...base, event: "failed" }).kind).toBe("error");
    expect(threadNotice({ ...base, event: "input" }).kind).toBe("other");
    expect(threadNotice({ ...base, event: "approval" }).kind).toBe("other");
  });

  it("keys by environment, thread, event and token", () => {
    expect(threadNotice({ ...base, event: "completed" }).key).toBe(
      "env-1:thread-1:completed:turn-1",
    );
    expect(threadNotice({ ...base, event: "failed", token: null }).key).toBe(
      "env-1:thread-1:failed:2026-01-05T09:00:00.000Z",
    );
  });
});

describe("persisted inbox", () => {
  it("drops expired rows on load", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    try {
      storage.set(
        "t3code.notifications.inbox.v1",
        JSON.stringify({
          version: 1,
          lastReadAt: null,
          notices: [notice("fresh", ago(1_000)), notice("old", ago(NOTICE_RETENTION_MS + 1_000))],
        }),
      );

      expect(readPersistedInbox().notices.map((entry) => entry.key)).toEqual(["fresh"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns an empty inbox for malformed storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "{not json",
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    try {
      expect(readPersistedInbox()).toEqual({ notices: [], lastReadAt: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("routine completion grouping", () => {
  const parentEnvironmentId = EnvironmentId.make("env-1");
  const parentThreadId = ThreadId.make("parent-1");
  const group = (childTitle: string, at: string) =>
    threadCompletedGroupNotice({ parentEnvironmentId, parentThreadId, childTitle, at });

  it("collapses three completions under one parent into one row with count and latest name", () => {
    const first = ago(3_000);
    const second = ago(2_000);
    const third = ago(1_000);
    const append = useNotificationsStore.getState().appendNotice;
    append(group("Child one", first));
    append(group("Child two", second));
    append(group("Child three", third));

    const notices = useNotificationsStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.key).toBe(threadCompletedGroupKey(parentEnvironmentId, parentThreadId));
    expect(notices[0]?.count).toBe(3);
    expect(notices[0]?.title).toBe("3 delegated results");
    expect(notices[0]?.body).toBe("Child three");
    expect(notices[0]?.at).toBe(third);
  });

  it("counts grouped rows, not children, in the unread badge", () => {
    const append = useNotificationsStore.getState().appendNotice;
    append(group("Child one", ago(3_000)));
    append(group("Child two", ago(2_000)));
    append(group("Child three", ago(1_000)));
    append(notice("failure", ago(500), { kind: "error" }));

    expect(selectUnreadNoticeCount(useNotificationsStore.getState())).toBe(2);
  });

  it("keeps important notices as their own row instead of merging them into the group", () => {
    const append = useNotificationsStore.getState().appendNotice;
    append(group("Child one", ago(3_000)));
    append(group("Child two", ago(2_000)));
    append(notice("env-1:child-9:failed:turn-9", ago(1_000), { kind: "error" }));

    const notices = useNotificationsStore.getState().notices;
    expect(notices).toHaveLength(2);
    expect(notices.find((entry) => entry.count !== undefined)?.count).toBe(2);
    expect(notices.some((entry) => entry.key === "env-1:child-9:failed:turn-9")).toBe(true);
  });

  it("caps routine rows but never prunes an important one", () => {
    const append = useNotificationsStore.getState().appendNotice;
    append(notice("failure", ago(60_000), { kind: "error" }));
    for (let index = 0; index < MAX_ROUTINE_NOTICES + 5; index += 1) {
      append(notice(`routine-${index}`, ago(120_000 - index * 1_000), { priority: "routine" }));
    }

    const notices = useNotificationsStore.getState().notices;
    expect(notices.some((entry) => entry.key === "failure")).toBe(true);
    expect(notices.filter((entry) => entry.priority === "routine")).toHaveLength(
      MAX_ROUTINE_NOTICES,
    );
  });

  it("expires routine notices at two hours but important ones at twenty-four", () => {
    const past = new Date(NOW - ROUTINE_NOTICE_RETENTION_MS - 1).toISOString();
    expect(isNoticeExpired(notice("important", past, { kind: "error" }), NOW)).toBe(false);
    expect(isNoticeExpired(notice("routine", past, { priority: "routine" }), NOW)).toBe(true);
  });
});
