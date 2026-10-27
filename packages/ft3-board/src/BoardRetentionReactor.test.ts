import { ThreadId, type ServerSettings } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations as runCoreMigrations } from "../../../apps/server/src/persistence/Migrations.ts";
import { runMigrations } from "../../ft3-host/src/Migrations.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import * as BoardRetentionReactor from "./BoardRetentionReactor.ts";
import { RETENTION_BATCH_LIMIT } from "./BoardRetentionReactor.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const NOW = "2026-01-15T13:00:00.000Z";
const NOW_MS = Date.UTC(2026, 0, 15, 13, 0, 0);
const NOW_INSTANT = DateTime.makeUnsafe(NOW);

const testCoordinator = (name: string): ThreadId => ThreadId.make(`retention-${name}`);

const isoDaysAgo = (days: number): string =>
  DateTime.formatIso(DateTime.subtract(NOW_INSTANT, { days }));
const isoHoursAgo = (hours: number): string =>
  DateTime.formatIso(DateTime.subtract(NOW_INSTANT, { hours }));

function makeCard(
  cardId: string,
  coordinator: ThreadId,
  overrides: Partial<Contracts.BoardCard> = {},
): Contracts.BoardCard {
  return {
    cardId: Contracts.BoardCardId.make(cardId),
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
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode,
        interaction_mode, created_at, updated_at, payload_json
      ) VALUES (
        ${coordinator}, 'project-1', 'Orchestrator', 'codex', 'full-access',
        'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'
      )
    `;
    const repository = yield* BoardRepository.BoardRepository;
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
    while (taken < total) taken = yield* Queue.take(harness.notifications);
  });

const startReactor = (harness: SettingsHarness) =>
  Effect.gen(function* () {
    const reactor = yield* BoardRetentionReactor.make.pipe(
      Effect.provide(Layer.mergeAll(harness.layer, BoardRepository.layer)),
    );
    yield* reactor.start();
    yield* waitForSettingsReads(harness, 1);
    return reactor;
  });

const retentionSettings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  boardArchiveAfterDays: 1,
  boardDeleteArchivedAfterDays: 14,
  ...overrides,
});

const seeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* runCoreMigrations();
    yield* runMigrations();
    return yield* effect;
  });

layer("BoardRetentionReactor", (it) => {
  it.effect("archives an old done card exactly once with one history entry", () =>
    Effect.scoped(
      seeded(
        Effect.gen(function* () {
          const coordinator = testCoordinator("archive-once");
          yield* TestClock.setTime(NOW_MS);
          yield* seedOrchestrator(coordinator);
          const repository = yield* BoardRepository.BoardRepository;
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

          const archived = (yield* repository.getCard(oldCard.cardId))!;
          assert.equal(archived.archived, true);
          assert.equal(archived.updatedAt, NOW);
          assert.equal(archived.title, oldCard.title);
          const history = yield* repository.listEventsForCard(oldCard.cardId);
          assert.equal(history.length, 1);
          assert.equal(history[0]?.body, "archived by retention");

          const young = (yield* repository.getCard(youngCard.cardId))!;
          assert.equal(young.archived, false);
          assert.equal(young.updatedAt, youngCard.updatedAt);
          assert.deepEqual(yield* repository.listEventsForCard(youngCard.cardId), []);

          yield* TestClock.adjust(Duration.hours(1));
          yield* waitForSettingsReads(settings, 2);

          const again = (yield* repository.getCard(oldCard.cardId))!;
          assert.equal(again.updatedAt, NOW);
          assert.equal((yield* repository.listEventsForCard(oldCard.cardId)).length, 1);
          const records = (yield* repository.listDeletionRecords()).filter(
            (record) => record.cardId === oldCard.cardId,
          );
          assert.deepEqual(records, []);
        }),
      ).pipe(Effect.provide(BoardRepository.layer)),
    ),
  );

  it.effect("never archives backlog or unfinished cards at any age", () =>
    Effect.scoped(
      seeded(
        Effect.gen(function* () {
          const coordinator = testCoordinator("never-archive");
          yield* TestClock.setTime(NOW_MS);
          yield* seedOrchestrator(coordinator);
          const repository = yield* BoardRepository.BoardRepository;
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

          const cards = yield* repository.listCards(coordinator);
          assert.equal(cards.length, statuses.length);
          for (const card of cards) {
            assert.equal(card.archived, false);
            assert.deepEqual(yield* repository.listEventsForCard(card.cardId), []);
          }
        }),
      ).pipe(Effect.provide(BoardRepository.layer)),
    ),
  );

  it.effect("deletes an old archived done card with its history and one record", () =>
    Effect.scoped(
      seeded(
        Effect.gen(function* () {
          const coordinator = testCoordinator("delete-old");
          yield* TestClock.setTime(NOW_MS);
          yield* seedOrchestrator(coordinator);
          const repository = yield* BoardRepository.BoardRepository;
          const card = makeCard("retention-delete-me", coordinator, {
            status: "done",
            archived: true,
            updatedAt: isoDaysAgo(15),
          });
          yield* repository.createCard(card, [
            BoardRepository.buildBoardCardEvent(card, {
              at: isoDaysAgo(15),
              body: "created",
              entryId: Contracts.BoardCardEventId.make("created"),
            }),
            BoardRepository.buildBoardCardEvent(card, {
              at: isoDaysAgo(14),
              body: "archived by retention",
              entryId: Contracts.BoardCardEventId.make("archived"),
            }),
          ]);
          const settings = yield* makeSettingsLayer(retentionSettings());

          yield* startReactor(settings);

          assert.equal(yield* repository.getCard(card.cardId), null);
          assert.deepEqual(yield* repository.listEventsForCard(card.cardId), []);
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

          yield* TestClock.adjust(Duration.hours(1));
          yield* waitForSettingsReads(settings, 2);
          assert.equal(
            (yield* repository.listDeletionRecords()).filter(
              (record) => record.cardId === card.cardId,
            ).length,
            1,
          );
        }),
      ).pipe(Effect.provide(BoardRepository.layer)),
    ),
  );

  it.effect("never deletes a manually archived unfinished card", () =>
    Effect.scoped(
      seeded(
        Effect.gen(function* () {
          const coordinator = testCoordinator("manual-archive");
          yield* TestClock.setTime(NOW_MS);
          yield* seedOrchestrator(coordinator);
          const repository = yield* BoardRepository.BoardRepository;
          const card = makeCard("retention-manual-archive", coordinator, {
            status: "todo",
            updatedAt: isoDaysAgo(90),
          });
          yield* repository.createCard(card);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE ft3_board_cards SET archived = 1 WHERE card_id = ${card.cardId}`;
          const settings = yield* makeSettingsLayer(retentionSettings());

          yield* startReactor(settings);
          yield* TestClock.adjust(Duration.hours(1));
          yield* waitForSettingsReads(settings, 2);

          const kept = (yield* repository.getCard(card.cardId))!;
          assert.equal(kept.archived, true);
          assert.equal(kept.status, "todo");
          assert.deepEqual(
            (yield* repository.listDeletionRecords()).filter(
              (record) => record.cardId === card.cardId,
            ),
            [],
          );
        }),
      ).pipe(Effect.provide(BoardRepository.layer)),
    ),
  );

  it.effect("applies changed settings on the next pass", () =>
    Effect.scoped(
      seeded(
        Effect.gen(function* () {
          const coordinator = testCoordinator("settings-change");
          yield* TestClock.setTime(NOW_MS);
          yield* seedOrchestrator(coordinator);
          const repository = yield* BoardRepository.BoardRepository;
          const card = makeCard("retention-settings-change", coordinator, {
            status: "done",
            archived: false,
            updatedAt: isoDaysAgo(10),
          });
          yield* repository.createCard(card);
          const settings = yield* makeSettingsLayer(
            retentionSettings({ boardArchiveAfterDays: 30 }),
          );

          yield* startReactor(settings);
          assert.equal((yield* repository.getCard(card.cardId))!.archived, false);

          yield* Ref.set(settings.current, retentionSettings({ boardArchiveAfterDays: 7 }));
          yield* TestClock.adjust(Duration.hours(1));
          yield* waitForSettingsReads(settings, 2);

          assert.equal((yield* repository.getCard(card.cardId))!.archived, true);
        }),
      ).pipe(Effect.provide(BoardRepository.layer)),
    ),
  );

  it.effect("archives at most one batch per pass", () =>
    Effect.scoped(
      seeded(
        Effect.gen(function* () {
          const coordinator = testCoordinator("batch-limit");
          yield* TestClock.setTime(NOW_MS);
          yield* seedOrchestrator(coordinator);
          const repository = yield* BoardRepository.BoardRepository;
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
          const remaining = (candidates: ReadonlyArray<{ readonly cardId: string }>) =>
            candidates.filter((candidate) => candidate.cardId.startsWith("retention-batch-"));
          const afterFirst = remaining(
            yield* repository.listArchiveCandidates({ cutoff: NOW, limit: total + 10 }),
          );
          assert.equal(afterFirst.length, 2);

          yield* TestClock.adjust(Duration.hours(1));
          yield* waitForSettingsReads(settings, 2);
          const afterSecond = remaining(
            yield* repository.listArchiveCandidates({ cutoff: NOW, limit: total + 10 }),
          );
          assert.deepEqual(afterSecond, []);
        }),
      ).pipe(Effect.provide(BoardRepository.layer)),
    ),
  );

  it.effect("removing the coordinator deletes archived cards with their history", () =>
    seeded(
      Effect.gen(function* () {
        const coordinator = testCoordinator("cascade");
        yield* seedOrchestrator(coordinator);
        const repository = yield* BoardRepository.BoardRepository;
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

        yield* repository.removeOrchestrator(coordinator);

        assert.deepEqual(yield* repository.listCards(coordinator), []);
      }),
    ).pipe(Effect.provide(BoardRepository.layer)),
  );
});
