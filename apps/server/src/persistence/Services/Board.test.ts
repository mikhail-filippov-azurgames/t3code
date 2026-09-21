import { BoardCardId, type BoardCard, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRepositoryLive } from "../Layers/Board.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { BoardRepository, buildBoardCardEvent } from "./Board.ts";

const repositoryLayer = it.layer(
  BoardRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        created_at, updated_at
      ) VALUES (
        ${threadId}, 'project-1', 'Orchestrator', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
  });

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    cardId: BoardCardId.make("card-1"),
    orchestratorThreadId: ThreadId.make("thread-1"),
    title: "Implement persistence",
    body: "Store board state in SQLite",
    status: "todo",
    createdBy: "human",
    assignee: null,
    executorRole: "implementation",
    executorThreadId: null,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: 0,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

repositoryLayer("BoardRepository", (it) => {
  it.effect("round-trips cards and ModelSelection and cascades events on deleteCard", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const threadId = ThreadId.make("thread-1");
      yield* seedThread(threadId);

      const orchestrator = yield* repository.addOrchestrator({
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.deepEqual(orchestrator, {
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5", [
        { id: "reasoningEffort", value: "high" },
      ]);
      const card = makeCard({ assignee: selection, order: 3 });
      yield* repository.createCard(card);

      const stored = yield* repository.getCard(BoardCardId.make("card-1"));
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.deepEqual(stored.value.assignee, selection);
        assert.equal(stored.value.archived, false);
        assert.equal(stored.value.order, 3);
      }

      const updated = makeCard({
        assignee: selection,
        order: 3,
        status: "review",
        archived: true,
        failureStreak: 2,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      yield* repository.updateCard(updated);

      const reread = yield* repository.getCard(BoardCardId.make("card-1"));
      assert.isTrue(Option.isSome(reread));
      if (Option.isSome(reread)) {
        assert.equal(reread.value.status, "review");
        assert.equal(reread.value.archived, true);
        assert.equal(reread.value.failureStreak, 2);
        assert.deepEqual(reread.value.assignee, selection);
      }

      const started = buildBoardCardEvent(updated, {
        at: "2026-01-02T00:00:01.000Z",
        body: "executor started",
      });
      const finished = buildBoardCardEvent(updated, { at: "2026-01-02T00:00:02.000Z" });
      assert.notEqual(started.entryId, finished.entryId);
      yield* repository.appendEvent(started);
      yield* repository.appendEvent(finished);

      const events = (yield* repository.listEvents()).filter(
        (event) => event.cardId === BoardCardId.make("card-1"),
      );
      assert.equal(events.length, 2);
      assert.equal(events[0]?.source, "system");
      assert.equal(events[0]?.model, "gpt-5");
      assert.equal(events[0]?.effort, "high");
      assert.equal(events[0]?.body, "executor started");
      assert.equal(events[1]?.body, undefined);

      yield* repository.deleteCard(BoardCardId.make("card-1"));
      assert.isTrue(Option.isNone(yield* repository.getCard(BoardCardId.make("card-1"))));
      assert.deepEqual(
        (yield* repository.listEvents()).filter(
          (event) => event.cardId === BoardCardId.make("card-1"),
        ),
        [],
      );
    }),
  );

  it.effect("removes orchestrator cards and events with the orchestrator", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const threadId = ThreadId.make("thread-2");
      yield* seedThread(threadId);
      yield* repository.addOrchestrator({
        threadId,
        createdBy: "orchestrator",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const first = makeCard({
        cardId: BoardCardId.make("card-2a"),
        orchestratorThreadId: threadId,
      });
      const second = makeCard({
        cardId: BoardCardId.make("card-2b"),
        orchestratorThreadId: threadId,
        order: 1,
      });
      yield* repository.createCard(first);
      yield* repository.createCard(second);
      yield* repository.appendEvent(buildBoardCardEvent(first, { at: "2026-01-01T00:00:01.000Z" }));
      yield* repository.appendEvent(
        buildBoardCardEvent(second, { at: "2026-01-01T00:00:02.000Z" }),
      );

      assert.equal(
        (yield* repository.listCards()).filter((card) => card.orchestratorThreadId === threadId)
          .length,
        2,
      );

      yield* repository.removeOrchestrator(threadId);

      assert.isFalse(
        (yield* repository.listOrchestrators()).some(
          (orchestrator) => orchestrator.threadId === threadId,
        ),
      );
      assert.deepEqual(
        (yield* repository.listCards()).filter((card) => card.orchestratorThreadId === threadId),
        [],
      );
      assert.deepEqual(
        (yield* repository.listEvents()).filter(
          (event) =>
            event.cardId === BoardCardId.make("card-2a") ||
            event.cardId === BoardCardId.make("card-2b"),
        ),
        [],
      );
    }),
  );

  it.effect("deletes only the target card's events on deleteCard", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const threadId = ThreadId.make("thread-3");
      yield* seedThread(threadId);
      yield* repository.addOrchestrator({
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const kept = makeCard({
        cardId: BoardCardId.make("card-3a"),
        orchestratorThreadId: threadId,
      });
      const removed = makeCard({
        cardId: BoardCardId.make("card-3b"),
        orchestratorThreadId: threadId,
        order: 1,
      });
      yield* repository.createCard(kept);
      yield* repository.createCard(removed);
      yield* repository.appendEvent(buildBoardCardEvent(kept, { at: "2026-01-01T00:00:01.000Z" }));
      yield* repository.appendEvent(
        buildBoardCardEvent(removed, { at: "2026-01-01T00:00:02.000Z" }),
      );

      yield* repository.deleteCard(BoardCardId.make("card-3b"));

      const cards = (yield* repository.listCards()).filter(
        (card) => card.orchestratorThreadId === threadId,
      );
      assert.deepEqual(
        cards.map((card) => card.cardId),
        [BoardCardId.make("card-3a")],
      );
      const events = (yield* repository.listEvents()).filter(
        (event) =>
          event.cardId === BoardCardId.make("card-3a") ||
          event.cardId === BoardCardId.make("card-3b"),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.cardId, BoardCardId.make("card-3a"));
    }),
  );
});
