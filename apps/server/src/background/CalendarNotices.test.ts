import { type CalendarRunNotice, CalendarEventId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { CALENDAR_NOTICE_RETENTION, make as makeCalendarNotices } from "./CalendarNotices.ts";

function makeNotice(eventId: string, observedAt: string): CalendarRunNotice {
  return {
    version: 1,
    eventId: CalendarEventId.make(eventId),
    status: "started",
    scheduledAt: observedAt,
    observedAt,
    name: "Standup",
  };
}

describe("CalendarNotices", () => {
  it.effect("replays the snapshot, then streams the whole list on a change", () =>
    Effect.gen(function* () {
      const channel = yield* makeCalendarNotices();
      const { latest, changes } = yield* channel.subscribe;
      assert.deepEqual(latest.notices, []);

      yield* channel.record(makeNotice("event-1", "2026-01-15T08:00:00.000Z"));
      const received = [...(yield* changes.pipe(Stream.take(1), Stream.runCollect))];

      assert.equal(received.length, 1);
      assert.deepEqual(
        received[0]?.notices.map((notice) => notice.eventId as string),
        ["event-1"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps notices newest first and ignores a repeated run key", () =>
    Effect.gen(function* () {
      const channel = yield* makeCalendarNotices();
      yield* channel.record(makeNotice("event-1", "2026-01-15T08:00:00.000Z"));
      yield* channel.record(makeNotice("event-1", "2026-01-15T08:00:00.000Z"));
      yield* channel.record(makeNotice("event-1", "2026-01-15T09:00:00.000Z"));

      const snapshot = yield* channel.snapshot;
      assert.deepEqual(
        snapshot.notices.map((notice) => notice.observedAt),
        ["2026-01-15T09:00:00.000Z", "2026-01-15T08:00:00.000Z"],
      );
    }),
  );

  it.effect("caps the retained list", () =>
    Effect.gen(function* () {
      const channel = yield* makeCalendarNotices();
      yield* Effect.forEach(
        Array.from({ length: CALENDAR_NOTICE_RETENTION + 5 }, (_, index) => index),
        (index) =>
          channel.record(
            makeNotice(
              `event-${index}`,
              `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
                index % 60,
              ).padStart(2, "0")}.000Z`,
            ),
          ),
        { discard: true },
      );

      const snapshot = yield* channel.snapshot;
      assert.equal(snapshot.notices.length, CALENDAR_NOTICE_RETENTION);
      assert.equal(snapshot.notices[0]?.eventId, `event-${CALENDAR_NOTICE_RETENTION + 4}`);
    }),
  );
});
