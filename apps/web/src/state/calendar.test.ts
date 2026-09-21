import {
  CalendarError,
  CalendarEventId,
  type CalendarRunNotice,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type CalendarEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  calendarFailureText,
  isNoticeUnread,
  selectUnreadNoticeCount,
  sortNoticesNewestFirst,
  useCalendarStore,
  type CalendarRunNoticeEnvelope,
} from "./calendar";

function makeEvent(eventId: string, title = "Daily review"): CalendarEvent {
  const now = new Date(2026, 0, 5, 8, 0).toISOString();
  return {
    eventId: CalendarEventId.make(eventId),
    projectId: ProjectId.make("project-test"),
    title,
    message: "Summarise the day.",
    mode: "new-thread",
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    nextFireAt: now,
    lastFiredAt: null,
    lastMissedAt: null,
    threadId: null,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  useCalendarStore.setState({
    events: [],
    notices: [],
    lastReadAt: null,
    lastNotifiedAt: null,
    transport: "offline",
    error: null,
  });
});

function makeNotice(eventId: string, observedAt: string): CalendarRunNoticeEnvelope {
  const notice: CalendarRunNotice = {
    version: 1,
    eventId: CalendarEventId.make(eventId),
    status: "started",
    scheduledAt: observedAt,
    observedAt,
    name: "Standup",
  };
  return { environmentId: EnvironmentId.make("environment-1"), notice };
}

describe("calendar store", () => {
  it("replaces the whole list with the server's answer", () => {
    useCalendarStore.getState().replaceEvents([makeEvent("event-a")]);
    expect(useCalendarStore.getState().events.map((event) => event.eventId)).toEqual(["event-a"]);

    useCalendarStore.getState().replaceEvents([makeEvent("event-b")]);
    expect(useCalendarStore.getState().events.map((event) => event.eventId)).toEqual(["event-b"]);
  });

  it("appends a new event and replaces an existing one by id", () => {
    const store = useCalendarStore.getState();
    store.upsertEvent(makeEvent("event-a", "First"));
    store.upsertEvent(makeEvent("event-b", "Second"));
    store.upsertEvent(makeEvent("event-a", "Renamed"));

    const events = useCalendarStore.getState().events;
    expect(events.map((event) => event.eventId)).toEqual(["event-a", "event-b"]);
    expect(events[0]?.title).toBe("Renamed");
  });

  it("removes an event by id", () => {
    useCalendarStore.getState().replaceEvents([makeEvent("event-a"), makeEvent("event-b")]);
    useCalendarStore.getState().removeEvent("event-a");
    expect(useCalendarStore.getState().events.map((event) => event.eventId)).toEqual(["event-b"]);
  });

  it("tracks transport and error separately", () => {
    useCalendarStore.getState().setTransport("live");
    useCalendarStore.getState().setError("denied");
    expect(useCalendarStore.getState().transport).toBe("live");
    expect(useCalendarStore.getState().error).toBe("denied");
  });
});

describe("calendar notice read state", () => {
  it("counts every notice as unread before the first read", () => {
    useCalendarStore.getState().replaceNotices([makeNotice("event-a", "2026-01-05T08:00:00.000Z")]);
    expect(selectUnreadNoticeCount(useCalendarStore.getState())).toBe(1);
  });

  it("clears the badge through the newest notice instant", () => {
    useCalendarStore
      .getState()
      .replaceNotices([
        makeNotice("event-a", "2026-01-05T08:00:00.000Z"),
        makeNotice("event-b", "2026-01-05T09:00:00.000Z"),
      ]);
    useCalendarStore.getState().markAllNoticesRead();

    expect(useCalendarStore.getState().lastReadAt).toBe("2026-01-05T09:00:00.000Z");
    expect(selectUnreadNoticeCount(useCalendarStore.getState())).toBe(0);
  });

  it("keeps a notice newer than the read cursor unread", () => {
    useCalendarStore.getState().replaceNotices([makeNotice("event-a", "2026-01-05T08:00:00.000Z")]);
    useCalendarStore.getState().markAllNoticesRead();
    useCalendarStore
      .getState()
      .replaceNotices([
        makeNotice("event-a", "2026-01-05T08:00:00.000Z"),
        makeNotice("event-b", "2026-01-05T10:00:00.000Z"),
      ]);

    expect(selectUnreadNoticeCount(useCalendarStore.getState())).toBe(1);
    expect(
      isNoticeUnread(
        makeNotice("event-a", "2026-01-05T08:00:00.000Z").notice,
        useCalendarStore.getState().lastReadAt,
      ),
    ).toBe(false);
  });

  it("sorts notices newest first", () => {
    useCalendarStore
      .getState()
      .replaceNotices([
        makeNotice("event-a", "2026-01-05T08:00:00.000Z"),
        makeNotice("event-b", "2026-01-05T09:00:00.000Z"),
      ]);
    expect(
      sortNoticesNewestFirst(useCalendarStore.getState().notices).map(
        ({ notice }) => notice.eventId as string,
      ),
    ).toEqual(["event-b", "event-a"]);
  });
});

describe("calendarFailureText", () => {
  it("prefers the error's own message", () => {
    expect(calendarFailureText(Cause.fail(new Error("Environment is not connected.")))).toBe(
      "Environment is not connected.",
    );
  });

  it("falls back to a tagged error's detail", () => {
    expect(
      calendarFailureText(
        Cause.fail(
          new CalendarError({
            operation: "calendar.create",
            detail: "Cron expression has no upcoming fire time.",
          }),
        ),
      ),
    ).toBe("Cron expression has no upcoming fire time.");
  });

  it("uses a neutral sentence when the error carries no text", () => {
    expect(calendarFailureText(Cause.fail({ detail: "   " }))).toBe(
      "The calendar server rejected the request.",
    );
  });
});
