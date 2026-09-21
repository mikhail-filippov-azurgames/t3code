import {
  CalendarEventId,
  type CalendarEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { CalendarEventRepository, CalendarEventRepositoryLive } from "./CalendarEvents.ts";

const repositoryLayer = it.layer(
  CalendarEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: CalendarEventId.make("event-1"),
    projectId: ProjectId.make("project-1"),
    title: "Standup",
    message: "Run the standup",
    mode: "new-thread",
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    nextFireAt: "2026-01-15T09:00:00.000Z",
    lastFiredAt: null,
    lastMissedAt: null,
    threadId: null,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

repositoryLayer("CalendarEventRepository update", (it) => {
  it.effect("replaces editable fields but preserves the reactor's run history", () =>
    Effect.gen(function* () {
      const repository = yield* CalendarEventRepository;
      yield* repository.create(makeEvent());
      yield* repository.recordFire({
        eventId: CalendarEventId.make("event-1"),
        firedAt: "2026-01-15T09:00:00.000Z",
        nextFireAt: "2026-01-16T09:00:00.000Z",
        updatedAt: "2026-01-15T09:00:00.000Z",
      });
      yield* repository.setThreadId({
        eventId: CalendarEventId.make("event-1"),
        threadId: ThreadId.make("thread-1"),
        updatedAt: "2026-01-15T09:00:01.000Z",
      });

      // The event handed to update carries hostile history values; the SQL must
      // ignore them and keep what recordFire/setThreadId wrote.
      yield* repository.update(
        makeEvent({
          title: "Renamed",
          message: "New body",
          cronExpression: "0 16 * * *",
          nextFireAt: "2026-01-16T16:00:00.000Z",
          lastFiredAt: "9999-12-31T00:00:00.000Z",
          lastMissedAt: "9999-12-31T00:00:00.000Z",
          threadId: ThreadId.make("ignored"),
          createdAt: "9999-12-31T00:00:00.000Z",
          updatedAt: "2026-01-15T10:00:00.000Z",
        }),
      );

      const stored = yield* repository.getById({ eventId: CalendarEventId.make("event-1") });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.equal(stored.value.title, "Renamed");
        assert.equal(stored.value.message, "New body");
        assert.equal(stored.value.cronExpression, "0 16 * * *");
        assert.equal(stored.value.nextFireAt, "2026-01-16T16:00:00.000Z");
        assert.equal(stored.value.updatedAt, "2026-01-15T10:00:00.000Z");
        assert.equal(stored.value.lastFiredAt, "2026-01-15T09:00:00.000Z");
        assert.equal(stored.value.lastMissedAt, null);
        assert.equal(stored.value.threadId, ThreadId.make("thread-1"));
        assert.equal(stored.value.createdAt, "2026-01-01T00:00:00.000Z");
      }
    }),
  );
});
