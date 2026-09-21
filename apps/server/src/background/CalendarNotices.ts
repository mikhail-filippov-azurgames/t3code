/**
 * CalendarNotices - the scheduled-run notification channel.
 *
 * The calendar reactor records one notice for every scheduled start and every
 * skipped (missed) slot. A WS subscription replays the current list and then
 * streams each change, so a client that connects late still sees what it missed
 * without polling. The list is in-memory: run notices are a live channel, not
 * an audit log, and a server restart drops them.
 *
 * @module CalendarNotices
 */
import {
  calendarRunNoticeKey,
  type CalendarNoticesResult,
  type CalendarRunNotice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  subscribeBeforeSnapshot,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";

/** Newest notices kept; older ones fall off the end of the streamed list. */
export const CALENDAR_NOTICE_RETENTION = 200;

export class CalendarNotices extends Context.Service<
  CalendarNotices,
  {
    readonly record: (notice: CalendarRunNotice) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<CalendarNoticesResult>;
    readonly subscribe: Effect.Effect<
      SnapshotSubscription<CalendarNoticesResult>,
      never,
      Scope.Scope
    >;
  }
>()("t3/background/CalendarNotices") {}

export const make = Effect.fn("CalendarNotices.make")(function* () {
  const noticesRef = yield* Ref.make<ReadonlyArray<CalendarRunNotice>>([]);
  // Sliding, because every published value is the whole list: a slow subscriber
  // only needs the latest one.
  const changes = yield* PubSub.sliding<CalendarNoticesResult>(1);
  const publishMutex = yield* Semaphore.make(1);

  const snapshot = Effect.map(Ref.get(noticesRef), (notices) => ({ notices }));

  const record: CalendarNotices["Service"]["record"] = (notice) =>
    publishMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.update(noticesRef, (current) => {
          const key = calendarRunNoticeKey(notice);
          if (current.some((existing) => calendarRunNoticeKey(existing) === key)) {
            return current;
          }
          return [notice, ...current].slice(0, CALENDAR_NOTICE_RETENTION);
        });
        yield* PubSub.publish(changes, yield* snapshot);
      }),
    );

  return CalendarNotices.of({
    record,
    snapshot,
    subscribe: subscribeBeforeSnapshot(changes, snapshot, publishMutex),
  });
});

export const layer = Layer.effect(CalendarNotices, make());
