import { BoardCardId, ThreadId, type BoardCard } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRepositoryLive } from "../Layers/Board.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { BoardRepository, buildBoardCardEvent } from "./Board.ts";

const repositoryLayer = it.layer(
  BoardRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const AT = "2026-01-01T00:00:00.000Z";
const FIRST = ThreadId.make("thread-scope-first");
const SECOND = ThreadId.make("thread-scope-second");

const seedOrchestrator = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* BoardRepository;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        created_at, updated_at
      ) VALUES (
        ${threadId}, 'project-1', 'Orchestrator', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', ${AT}, ${AT}
      )
    `;
    yield* repository.addOrchestrator({ threadId, createdBy: "human", createdAt: AT });
  });

const makeCard = (
  cardId: string,
  orchestratorThreadId: ThreadId,
  overrides: Partial<BoardCard> = {},
): BoardCard => ({
  cardId: BoardCardId.make(cardId),
  orchestratorThreadId,
  title: cardId,
  body: "body",
  status: "todo",
  readiness: "ready",
  readinessNote: null,
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

repositoryLayer("BoardRepository list scope", (it) => {
  it.effect("filters the archive in SQL and leaves the unfiltered read unchanged", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seedOrchestrator(FIRST);
      yield* seedOrchestrator(SECOND);

      const cards = [
        makeCard("scope-a-todo", FIRST),
        makeCard("scope-a-progress", FIRST, { status: "in_progress", order: 1 }),
        makeCard("scope-a-done-1", FIRST, { status: "done", archived: true, order: 2 }),
        makeCard("scope-a-done-2", FIRST, { status: "done", archived: true, order: 3 }),
        makeCard("scope-b-backlog", SECOND, { status: "backlog" }),
        makeCard("scope-b-done", SECOND, { status: "done", archived: true }),
      ];
      yield* Effect.forEach(cards, (card) => repository.createCard(card));
      let minute = 0;
      for (const card of cards) {
        for (let index = 0; index < 2; index += 1) {
          minute += 1;
          yield* repository.appendEvent(
            buildBoardCardEvent(card, {
              at: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
              body: `${card.cardId}-${index}`,
            }),
          );
        }
      }

      // Today's reads, straight from the table: the unscoped read must keep matching them.
      const legacyCardIds = (yield* sql`
        SELECT card_id AS "id" FROM board_cards
        ORDER BY orchestrator_thread_id ASC, order_index ASC, created_at ASC, card_id ASC
      `).map((row) => String(row.id));
      const legacyEventIds = (yield* sql`
        SELECT entry_id AS "id" FROM board_card_events ORDER BY at ASC, entry_id ASC
      `).map((row) => String(row.id));

      const everyCard = yield* repository.listCards();
      const everyEvent = yield* repository.listEvents();
      assert.deepEqual(
        everyCard.map((card) => card.cardId),
        legacyCardIds,
      );
      assert.deepEqual(
        everyEvent.map((event) => event.entryId),
        legacyEventIds,
      );
      assert.deepEqual(yield* repository.listCards({ includeArchived: true }), everyCard);
      assert.deepEqual(yield* repository.listEvents({ includeArchived: true }), everyEvent);
      assert.equal(everyCard.length, 6);
      assert.equal(everyEvent.length, 12);

      const activeCards = yield* repository.listCards({ includeArchived: false });
      assert.deepEqual(
        activeCards,
        everyCard.filter((card) => !card.archived),
      );
      assert.equal(activeCards.length, 3);
      const activeIds = new Set(activeCards.map((card) => card.cardId));
      const activeEvents = yield* repository.listEvents({ includeArchived: false });
      assert.deepEqual(
        activeEvents,
        everyEvent.filter((event) => activeIds.has(event.cardId)),
      );
      assert.equal(activeEvents.length, 6);

      assert.deepEqual(yield* repository.countArchivedCards(), [
        { orchestratorThreadId: FIRST, status: "done", count: 2 },
        { orchestratorThreadId: SECOND, status: "done", count: 1 },
      ]);
    }),
  );
});
