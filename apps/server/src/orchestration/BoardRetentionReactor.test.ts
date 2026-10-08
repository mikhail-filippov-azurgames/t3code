import {
  BoardCardId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type BoardCard,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { BoardRepository, buildBoardCardEvent } from "../persistence/Services/Board.ts";
import { BoardRepositoryLive } from "../persistence/Layers/Board.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as BoardRetentionReactor from "./BoardRetentionReactor.ts";
import { RETENTION_BATCH_LIMIT } from "./BoardRetentionReactor.ts";

const repositoryLayer = it.layer(
  BoardRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const NOW = "2026-01-15T13:00:00.000Z";
const NOW_MS = Date.UTC(2026, 0, 15, 13, 0, 0);
const NOW_INSTANT = DateTime.makeUnsafe(NOW);

/** One coordinator per test: the layer's in-memory database is shared. */
const testCoordinator = (name: string): ThreadId => ThreadId.make(`retention-${name}`);

const isoDaysAgo = (days: number): string =>
  DateTime.formatIso(DateTime.subtract(NOW_INSTANT, { days }));
const isoHoursAgo = (hours: number): string =>
  DateTime.formatIso(DateTime.subtract(NOW_INSTANT, { hours }));

function makeCard(
  cardId: string,
  coordinator: ThreadId,
  overrides: Partial<BoardCard> = {},
): BoardCard {
  return {
    cardId: BoardCardId.make(cardId),
    orchestratorThreadId: coordinator,
    title: `Task ${cardId}`,
    body: "Implement the task",
    status: "done",
    readiness: "ready",
    readinessNote: null,
    createdBy: "orchestrator",
    assignee: null,
    executorRole: "implementation",
    executorThreadId: null,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: 0,
    archived: false,
    createdAt: isoDaysAgo(30),
    updatedAt: isoDaysAgo(2),
    ...overrides,
  };
}

const seedOrchestrator = (coordinator: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        created_at, updated_at
      ) VALUES (
        ${coordinator}, 'project-1', 'Orchestrator', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    const repository = yield* BoardRepository;
    yield* repository.addOrchestrator({
      threadId: coordinator,
      createdBy: "human",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

function makeSettingsLayer(initial: ServerSettings) {
  return Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const notifications = yield* Queue.unbounded<number>();
    const reads = yield* Ref.make(0);
    const layer = Layer.mock(ServerSettingsService)({
      getSettings: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(reads, (read) => read + 1);
        yield* Queue.offer(notifications, count);
        return yield* Ref.get(current);
      }),
    });
    return { current, notifications, layer };
  });
}

type SettingsHarness = Effect.Success<ReturnType<typeof makeSettingsLayer>>;

const waitForSettingsReads = (harness: SettingsHarness, total: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    let taken = 0;
    while (taken < total) {
      taken = yield* Queue.take(harness.notifications);
    }
  });

const startReactor = (harness: SettingsHarness) =>
  Effect.gen(function* () {
    // The reactor builds on board storage and settings alone: there is no
    // engine to dispatch through, so a pass cannot wake any coordinator.
    const reactor = yield* BoardRetentionReactor.make.pipe(Effect.provide(harness.layer));
    yield* reactor.start();
    yield* waitForSettingsReads(harness, 2);
    return reactor;
  });

const retentionSettings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  boardArchiveAfterDays: 1,
  boardDeleteArchivedAfterDays: 14,
  ...overrides,
});

repositoryLayer("BoardRetentionReactor", (it) => {
  it.effect("archives an old done card exactly once with one history entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = testCoordinator("archive-once");
        yield* TestClock.setTime(NOW_MS);
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository;
        const oldCard = makeCard("retention-old-done", coordinator, {
          status: "done",
          archived: false,
          updatedAt: isoDaysAgo(2),
        });
        const youngCard = makeCard("retention-young-done", coordinator, {
          status: "done",
          archived: false,
          updatedAt: isoHoursAgo(12),
        });
        yield* repository.createCard(oldCard);
        yield* repository.createCard(youngCard);
        const settings = yield* makeSettingsLayer(retentionSettings());

        yield* startReactor(settings);

        const archived = Option.getOrThrow(yield* repository.getCard(oldCard.cardId));
        assert.equal(archived.archived, true);
        assert.equal(archived.updatedAt, NOW);
        assert.equal(archived.title, oldCard.title);
        const history = yield* repository.listEventsForCard({ cardId: oldCard.cardId });
        assert.equal(history.length, 1);
        assert.equal(history[0]?.body, "archived by retention");

        const young = Option.getOrThrow(yield* repository.getCard(youngCard.cardId));
        assert.equal(young.archived, false);
        assert.equal(young.updatedAt, youngCard.updatedAt);
        assert.deepEqual(yield* repository.listEventsForCard({ cardId: youngCard.cardId }), []);

        // A second pass duplicates nothing: the archived card is no longer a
        // candidate, and the young one is still too fresh.
        yield* TestClock.adjust(Duration.hours(1));
        yield* waitForSettingsReads(settings, 4);

        const again = Option.getOrThrow(yield* repository.getCard(oldCard.cardId));
        assert.equal(again.updatedAt, NOW);
        assert.equal((yield* repository.listEventsForCard({ cardId: oldCard.cardId })).length, 1);
        const records = (yield* repository.listDeletionRecords()).filter(
          (record) => record.cardId === oldCard.cardId,
        );
        assert.deepEqual(records, []);
      }),
    ),
  );

  it.effect("never archives backlog or unfinished cards at any age", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = testCoordinator("never-archive");
        yield* TestClock.setTime(NOW_MS);
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository;
        const statuses = ["backlog", "todo", "orchestrator", "in_progress", "review"] as const;
        for (const [index, status] of statuses.entries()) {
          yield* repository.createCard(
            makeCard(`retention-unfinished-${index}`, coordinator, {
              status,
              archived: false,
              updatedAt: isoDaysAgo(90),
            }),
          );
        }
        const settings = yield* makeSettingsLayer(retentionSettings());

        yield* startReactor(settings);

        const cards = (yield* repository.listCards()).filter(
          (card) => card.orchestratorThreadId === coordinator,
        );
        assert.equal(cards.length, statuses.length);
        for (const card of cards) {
          assert.equal(card.archived, false);
          assert.deepEqual(yield* repository.listEventsForCard({ cardId: card.cardId }), []);
        }
      }),
    ),
  );

  it.effect("deletes an old archived done card with its history and one record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = testCoordinator("delete-old");
        yield* TestClock.setTime(NOW_MS);
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository;
        const card = makeCard("retention-delete-me", coordinator, {
          status: "done",
          archived: true,
          updatedAt: isoDaysAgo(15),
        });
        yield* repository.createCard(card);
        for (const [index, body] of ["created", "archived by retention"].entries()) {
          yield* repository.appendEvent(
            buildBoardCardEvent(card, { at: isoDaysAgo(15 - index), body }),
          );
        }
        const settings = yield* makeSettingsLayer(retentionSettings());

        yield* startReactor(settings);

        assert.deepEqual(Option.getOrUndefined(yield* repository.getCard(card.cardId)), undefined);
        assert.deepEqual(yield* repository.listEventsForCard({ cardId: card.cardId }), []);
        const records = (yield* repository.listDeletionRecords()).filter(
          (record) => record.cardId === card.cardId,
        );
        assert.equal(records.length, 1);
        assert.deepEqual(records[0], {
          cardId: card.cardId,
          orchestratorThreadId: coordinator,
          deletedAt: NOW,
          reason: "retention",
          historyEventCount: 2,
        });

        // A repeat pass deletes nothing further and records nothing further.
        yield* TestClock.adjust(Duration.hours(1));
        yield* waitForSettingsReads(settings, 4);
        assert.equal(
          (yield* repository.listDeletionRecords()).filter(
            (record) => record.cardId === card.cardId,
          ).length,
          1,
        );
      }),
    ),
  );

  it.effect("never deletes a manually archived unfinished card", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = testCoordinator("manual-archive");
        yield* TestClock.setTime(NOW_MS);
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository;
        const card = makeCard("retention-manual-archive", coordinator, {
          status: "todo",
          updatedAt: isoDaysAgo(90),
        });
        yield* repository.createCard(card);
        // The repository refuses to archive an unfinished card, so seed the legacy row directly.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE board_cards SET archived = 1 WHERE card_id = ${card.cardId}`;
        const settings = yield* makeSettingsLayer(retentionSettings());

        yield* startReactor(settings);
        yield* TestClock.adjust(Duration.hours(1));
        yield* waitForSettingsReads(settings, 4);

        const kept = Option.getOrThrow(yield* repository.getCard(card.cardId));
        assert.equal(kept.archived, true);
        assert.equal(kept.status, "todo");
        const records = (yield* repository.listDeletionRecords()).filter(
          (record) => record.cardId === card.cardId,
        );
        assert.deepEqual(records, []);
      }),
    ),
  );

  it.effect("applies changed settings on the next pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = testCoordinator("settings-change");
        yield* TestClock.setTime(NOW_MS);
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository;
        const card = makeCard("retention-settings-change", coordinator, {
          status: "done",
          archived: false,
          updatedAt: isoDaysAgo(10),
        });
        yield* repository.createCard(card);
        const settings = yield* makeSettingsLayer(retentionSettings({ boardArchiveAfterDays: 30 }));

        yield* startReactor(settings);
        assert.equal(Option.getOrThrow(yield* repository.getCard(card.cardId)).archived, false);

        yield* Ref.set(settings.current, retentionSettings({ boardArchiveAfterDays: 7 }));
        yield* TestClock.adjust(Duration.hours(1));
        yield* waitForSettingsReads(settings, 4);

        assert.equal(Option.getOrThrow(yield* repository.getCard(card.cardId)).archived, true);
      }),
    ),
  );

  it.effect("archives at most one batch per pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = testCoordinator("batch-limit");
        yield* TestClock.setTime(NOW_MS);
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository;
        assert.isTrue(RETENTION_BATCH_LIMIT > 0);
        const total = RETENTION_BATCH_LIMIT + 2;
        for (let index = 0; index < total; index += 1) {
          yield* repository.createCard(
            makeCard(`retention-batch-${index}`, coordinator, {
              status: "done",
              archived: false,
              updatedAt: isoDaysAgo(2),
            }),
          );
        }
        const settings = yield* makeSettingsLayer(retentionSettings());

        yield* startReactor(settings);
        const remaining = (candidates: ReadonlyArray<BoardCard>) =>
          candidates.filter((card) => card.orchestratorThreadId === coordinator);
        const afterFirst = remaining(
          yield* repository.listArchiveCandidates({ cutoff: NOW, limit: total + 10 }),
        );
        assert.equal(afterFirst.length, 2);

        yield* TestClock.adjust(Duration.hours(1));
        yield* waitForSettingsReads(settings, 4);
        const afterSecond = remaining(
          yield* repository.listArchiveCandidates({ cutoff: NOW, limit: total + 10 }),
        );
        assert.deepEqual(afterSecond, []);
      }),
    ),
  );

  it.effect("removing the coordinator deletes archived cards with their history", () =>
    Effect.gen(function* () {
      const coordinator = testCoordinator("cascade");
      yield* seedOrchestrator(coordinator);
      const repository = yield* BoardRepository;
      const active = makeCard("retention-cascade-active", coordinator, {
        status: "todo",
        archived: false,
      });
      const archived = makeCard("retention-cascade-archived", coordinator, {
        status: "done",
        archived: true,
      });
      yield* repository.createCard(active);
      yield* repository.createCard(archived);
      yield* repository.appendEvent(buildBoardCardEvent(active, { at: NOW }));
      yield* repository.appendEvent(buildBoardCardEvent(archived, { at: NOW }));

      yield* repository.removeOrchestrator(coordinator);

      const remaining = (yield* repository.listCards()).filter(
        (card) => card.orchestratorThreadId === coordinator,
      );
      assert.deepEqual(remaining, []);
      assert.deepEqual(yield* repository.listEventsForCard({ cardId: active.cardId }), []);
      assert.deepEqual(yield* repository.listEventsForCard({ cardId: archived.cardId }), []);
    }),
  );
});
