import {
  CalendarEventId,
  ProjectId,
  ProviderInstanceId,
  type CalendarEvent,
  type CalendarRunNotice,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it, vi } from "vite-plus/test";

import {
  addDays,
  browserTimeZone,
  composeCron,
  cronMatchesDay,
  describeCalendarRunNotice,
  eventOccurrencesBetween,
  formatClock,
  formatTimeZoneLabel,
  inferCalendarRepeat,
  nextCronOccurrence,
  parseCron,
  startOfDay,
  startOfWeek,
} from "./calendar.logic";

function makeEvent(cronExpression: string): CalendarEvent {
  const now = new Date(2026, 0, 5, 8, 0).toISOString();
  return {
    eventId: CalendarEventId.make("event-test"),
    projectId: ProjectId.make("project-test"),
    title: "Daily review",
    message: "Summarise the day.",
    mode: "new-thread",
    cronExpression,
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

describe("parseCron", () => {
  it("rejects an expression that is not five fields", () => {
    assert.equal(parseCron("0 9 * *"), null);
  });

  it("rejects an out-of-range value", () => {
    assert.equal(parseCron("99 9 * * *"), null);
  });

  it("normalises both Sunday values to 0", () => {
    const parsed = parseCron("0 16 * * 7");
    assert.ok(parsed !== null);
    assert.deepEqual([...parsed.dayOfWeek.values], [0]);
    assert.equal(parsed.dayOfWeek.restricted, true);
  });

  it("keeps an unrestricted day field unrestricted", () => {
    const parsed = parseCron("0 16 * * *");
    assert.ok(parsed !== null);
    assert.equal(parsed.dayOfWeek.restricted, false);
    assert.equal(parsed.dayOfMonth.restricted, false);
  });

  it("accepts a stepped wildcard and a stepped range", () => {
    const stepped = parseCron("*/15 9-17 * * *");
    assert.ok(stepped !== null);
    assert.deepEqual([...stepped.minute.values], [0, 15, 30, 45]);
    assert.deepEqual([...stepped.hour.values], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("reads a bare n/step as n through the field maximum like the server", () => {
    const parsed = parseCron("5/10 9 * * *");
    assert.ok(parsed !== null);
    assert.deepEqual([...parsed.minute.values], [5, 15, 25, 35, 45, 55]);
  });
});

describe("composeCron", () => {
  const start = new Date(2026, 0, 7, 16, 5); // Wednesday, 2026-01-07.

  it("encodes hourly at the chosen minute", () => {
    assert.equal(composeCron(start, "hourly"), "5 * * * *");
  });

  it("encodes daily at the chosen time", () => {
    assert.equal(composeCron(start, "daily"), "5 16 * * *");
  });

  it("encodes weekly on the chosen weekday", () => {
    assert.equal(composeCron(start, "weekly"), "5 16 * * 3");
  });

  it("encodes monthly on the chosen day", () => {
    assert.equal(composeCron(start, "monthly"), "5 16 7 * *");
  });

  it("encodes yearly with month and day", () => {
    assert.equal(composeCron(start, "yearly"), "5 16 7 1 *");
  });

  it("passes a custom expression through trimmed", () => {
    assert.equal(composeCron(start, "custom", "  0 16 * * 1-5 "), "0 16 * * 1-5");
  });
});

describe("inferCalendarRepeat", () => {
  it("recognises the shapes the form composes", () => {
    assert.equal(inferCalendarRepeat("5 * * * *"), "hourly");
    assert.equal(inferCalendarRepeat("5 16 * * *"), "daily");
    assert.equal(inferCalendarRepeat("5 16 * * 3"), "weekly");
    assert.equal(inferCalendarRepeat("5 16 7 * *"), "monthly");
    assert.equal(inferCalendarRepeat("5 16 7 1 *"), "yearly");
  });

  it("falls back to custom for stepped, listed or invalid expressions", () => {
    assert.equal(inferCalendarRepeat("*/15 * * * *"), "custom");
    assert.equal(inferCalendarRepeat("0 16 * * 1-5"), "custom");
    assert.equal(inferCalendarRepeat("not a cron"), "custom");
  });
});

describe("cronMatchesDay", () => {
  it("ORs restricted day-of-month and day-of-week", () => {
    const parsed = parseCron("0 9 1 * 1");
    assert.ok(parsed !== null);
    // 2026-01-05 is a Monday that is not the 1st.
    assert.equal(cronMatchesDay(parsed, new Date(2026, 0, 5)), true);
    // 2026-01-01 is the 1st but a Thursday.
    assert.equal(cronMatchesDay(parsed, new Date(2026, 0, 1)), true);
    // Neither.
    assert.equal(cronMatchesDay(parsed, new Date(2026, 0, 2)), false);
  });

  it("requires both when one side is unrestricted", () => {
    const parsed = parseCron("0 9 1 * *");
    assert.ok(parsed !== null);
    assert.equal(cronMatchesDay(parsed, new Date(2026, 0, 5)), false);
    assert.equal(cronMatchesDay(parsed, new Date(2026, 0, 1)), true);
  });
});

describe("eventOccurrencesBetween", () => {
  it("finds one occurrence per day for a daily repeat", () => {
    const rangeStart = startOfDay(new Date(2026, 0, 5));
    const rangeEnd = addDays(rangeStart, 7);
    const occurrences = eventOccurrencesBetween(makeEvent("0 9 * * *"), rangeStart, rangeEnd);
    assert.equal(occurrences.length, 7);
    for (const occurrence of occurrences) {
      assert.equal(occurrence.getHours(), 9);
      assert.equal(occurrence.getMinutes(), 0);
    }
  });

  it("finds one occurrence a week for a weekly repeat", () => {
    const rangeStart = startOfWeek(new Date(2026, 0, 7), 1);
    const rangeEnd = addDays(rangeStart, 7);
    const occurrences = eventOccurrencesBetween(makeEvent("30 14 * * 3"), rangeStart, rangeEnd);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]?.getDay(), 3);
  });

  it("returns nothing before the range", () => {
    const rangeStart = startOfDay(new Date(2026, 0, 5));
    const occurrences = eventOccurrencesBetween(makeEvent("0 9 * * *"), rangeStart, rangeStart);
    assert.equal(occurrences.length, 0);
  });
});

describe("nextCronOccurrence", () => {
  it("advances to tomorrow when today's slot has passed", () => {
    const from = new Date(2026, 0, 5, 17, 0);
    const next = nextCronOccurrence("0 16 * * *", from);
    assert.ok(next !== null);
    assert.equal(next.getDate(), 6);
    assert.equal(next.getHours(), 16);
  });

  it("keeps today's slot when it is still ahead", () => {
    const from = new Date(2026, 0, 5, 9, 0);
    const next = nextCronOccurrence("0 16 * * *", from);
    assert.ok(next !== null);
    assert.equal(next.getDate(), 5);
    assert.equal(next.getHours(), 16);
  });

  it("returns null for an invalid expression", () => {
    assert.equal(nextCronOccurrence("not a cron", new Date(2026, 0, 5)), null);
  });
});

describe("describeCalendarRunNotice", () => {
  const formatTime = (iso: string) => formatClock(new Date(iso));
  const scheduledAt = new Date(2026, 0, 5, 16, 0).toISOString();

  it("names the fact, the time and the capped event name on start", () => {
    const longName = "x".repeat(90);
    const notice: CalendarRunNotice = {
      version: 1,
      eventId: CalendarEventId.make("event-test"),
      status: "started",
      scheduledAt,
      observedAt: scheduledAt,
      name: longName,
    };
    const presentation = describeCalendarRunNotice(notice, formatTime);
    assert.equal(presentation.title, "Scheduled task started");
    assert.equal(presentation.tone, "success");
    assert.ok(presentation.body.includes("16:00"));
    assert.ok(presentation.body.includes("..."));
    assert.ok(presentation.body.length < longName.length);
  });

  it("marks a missed run as skipped with a warning tone", () => {
    const notice: CalendarRunNotice = {
      version: 1,
      eventId: CalendarEventId.make("event-test"),
      status: "skipped-missed",
      scheduledAt,
      observedAt: scheduledAt,
      name: "Daily review",
    };
    const presentation = describeCalendarRunNotice(notice, formatTime);
    assert.equal(presentation.title, "Scheduled task skipped");
    assert.equal(presentation.tone, "warning");
    assert.ok(presentation.body.includes("missed"));
  });
});

describe("startOfWeek", () => {
  it("walks back to the configured first day", () => {
    assert.equal(startOfWeek(new Date(2026, 0, 7), 0).getDay(), 0);
    assert.equal(startOfWeek(new Date(2026, 0, 7), 1).getDay(), 1);
  });
});

describe("local wall-clock DST handling", () => {
  it("resolves an ambiguous fall-back slot to the earlier instant once", () => {
    try {
      vi.stubEnv("TZ", "America/New_York");
      const from = new Date("2026-10-15T12:00:00.000Z");
      const next = nextCronOccurrence("30 1 1 11 *", from);
      assert.ok(next !== null);
      assert.equal(next.toISOString(), "2026-11-01T05:30:00.000Z");
      assert.equal(next.getHours(), 1);

      const occurrences = eventOccurrencesBetween(
        makeEvent("30 1 1 11 *"),
        new Date("2026-11-01T00:00:00.000Z"),
        new Date("2026-11-02T00:00:00.000Z"),
      );
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0]?.toISOString(), "2026-11-01T05:30:00.000Z");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("skips a spring-forward gap slot", () => {
    try {
      vi.stubEnv("TZ", "America/New_York");
      const next = nextCronOccurrence("30 2 8 3 *", new Date("2026-01-15T00:00:00.000Z"));
      assert.ok(next !== null);
      assert.equal(next.toISOString(), "2027-03-08T07:30:00.000Z");
      const occurrences = eventOccurrencesBetween(
        makeEvent("30 2 8 3 *"),
        new Date("2026-03-08T00:00:00.000Z"),
        new Date("2026-03-09T00:00:00.000Z"),
      );
      assert.equal(occurrences.length, 0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("browser display zone", () => {
  it("reads the single source from Intl", () => {
    assert.equal(browserTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });

  it("labels the zone via Intl", () => {
    const date = new Date(2026, 0, 5, 12, 0);
    const expected =
      new Intl.DateTimeFormat(undefined, {
        timeZone: browserTimeZone(),
        timeZoneName: "short",
      })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? browserTimeZone();
    assert.equal(formatTimeZoneLabel(date), expected);
    assert.ok(formatTimeZoneLabel(date).length > 0);
  });

  it("keeps day boundaries and upcoming in the browser zone for an event stored in another zone", () => {
    try {
      vi.stubEnv("TZ", "America/New_York");
      const event = { ...makeEvent("0 9 * * *"), timeZone: "Asia/Tokyo" };
      const rangeStart = startOfDay(new Date(2026, 0, 5, 12, 0));
      const rangeEnd = addDays(rangeStart, 1);
      const occurrences = eventOccurrencesBetween(event, rangeStart, rangeEnd);
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0]?.getHours(), 9);

      const next = nextCronOccurrence(event.cronExpression, new Date(2026, 0, 5, 8, 0));
      assert.ok(next !== null);
      assert.equal(next.getDate(), 5);
      assert.equal(next.getHours(), 9);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
