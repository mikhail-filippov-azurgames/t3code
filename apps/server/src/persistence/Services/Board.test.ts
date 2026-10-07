import { BoardCardId, type BoardCard, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRepositoryLive } from "../Layers/Board.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { BoardRepository, BoardRepositoryError, buildBoardCardEvent } from "./Board.ts";

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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

repositoryLayer("BoardRepository", (it) => {
  it.effect("finds at most two cards by prefix and scopes history to one card", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const threadId = ThreadId.make("thread-board-prefix-search");
      yield* seedThread(threadId);
      yield* repository.addOrchestrator({
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const unique = makeCard({
        cardId: BoardCardId.make("1a2b3c4d-0000-4000-8000-000000000001"),
        orchestratorThreadId: threadId,
      });
      const ambiguous = [
        makeCard({
          cardId: BoardCardId.make("5a6b7c8d-0000-4000-8000-000000000001"),
          orchestratorThreadId: threadId,
        }),
        makeCard({
          cardId: BoardCardId.make("5a6b7c8d-0000-4000-8000-000000000002"),
          orchestratorThreadId: threadId,
        }),
        makeCard({
          cardId: BoardCardId.make("5a6b7c8d-0000-4000-8000-000000000003"),
          orchestratorThreadId: threadId,
        }),
      ];
      yield* repository.createCard(unique);
      yield* Effect.forEach(ambiguous, (card) => repository.createCard(card));

      assert.deepEqual(
        (yield* repository.findCardsByPrefix("1a2b3c4d")).map((card) => card.cardId),
        [unique.cardId],
      );
      assert.equal((yield* repository.findCardsByPrefix("5a6b7c8d")).length, 2);
      assert.deepEqual(yield* repository.findCardsByPrefix("ffffffff"), []);

      for (let index = 1; index <= 4; index += 1) {
        yield* repository.appendEvent(
          buildBoardCardEvent(unique, {
            at: `2026-01-01T00:00:0${index}.000Z`,
            body: `event-${index}`,
          }),
        );
      }
      const recent = yield* repository.listEventsForCard({ cardId: unique.cardId, limit: 3 });
      assert.deepEqual(
        recent.map((event) => event.body),
        ["event-4", "event-3", "event-2"],
      );
      const history = yield* repository.listEventsForCard({ cardId: unique.cardId });
      assert.deepEqual(
        history.map((event) => event.body),
        ["event-1", "event-2", "event-3", "event-4"],
      );
    }),
  );

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
      const card = makeCard({
        assignee: selection,
        order: 3,
        readiness: "needs_human",
        readinessNote: "Which draft should I review?",
      });
      yield* repository.createCard(card);

      const stored = yield* repository.getCard(BoardCardId.make("card-1"));
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.deepEqual(stored.value.assignee, selection);
        assert.equal(stored.value.archived, false);
        assert.equal(stored.value.order, 3);
        assert.equal(stored.value.readiness, "needs_human");
        assert.equal(stored.value.readinessNote, "Which draft should I review?");
      }

      const updated = makeCard({
        assignee: selection,
        order: 3,
        status: "review",
        archived: true,
        readiness: "blocked",
        readinessNote: "Waiting for the architecture plan",
        failureStreak: 2,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      yield* repository.updateCard(updated);

      const reread = yield* repository.getCard(BoardCardId.make("card-1"));
      assert.isTrue(Option.isSome(reread));
      if (Option.isSome(reread)) {
        assert.equal(reread.value.status, "review");
        assert.equal(reread.value.archived, true);
        assert.equal(reread.value.readiness, "blocked");
        assert.equal(reread.value.readinessNote, "Waiting for the architecture plan");
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

  it.effect(
    "stores and rereads a backlog card, and one unreadable status fails the whole list",
    () =>
      Effect.gen(function* () {
        const repository = yield* BoardRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-backlog-card");
        yield* seedThread(threadId);
        yield* repository.addOrchestrator({
          threadId,
          createdBy: "human",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        const backlog = makeCard({
          cardId: BoardCardId.make("backlog-card"),
          orchestratorThreadId: threadId,
          status: "backlog",
        });
        const other = makeCard({
          cardId: BoardCardId.make("backlog-other-card"),
          orchestratorThreadId: threadId,
        });
        yield* repository.createCard(backlog);
        yield* repository.createCard(other);
        yield* repository.appendEvent(
          buildBoardCardEvent(backlog, { at: "2026-01-01T00:00:01.000Z" }),
        );

        yield* Effect.gen(function* () {
          const stored = yield* repository.getCard(backlog.cardId);
          assert.equal(Option.getOrThrow(stored).status, "backlog");
          const listed = yield* repository.listCards();
          assert.includeMembers(
            listed
              .filter((card) => card.orchestratorThreadId === threadId)
              .map((card) => card.status),
            ["backlog", "todo"],
          );
          const events = yield* repository.listEventsForCard({ cardId: backlog.cardId });
          assert.equal(events[0]?.status, "backlog");

          // What a server that predates the status sees: the list read fails as a whole.
          yield* sql`UPDATE board_cards SET status = 'unknown_status' WHERE card_id = ${backlog.cardId}`;
          const error = yield* Effect.flip(repository.listCards());
          assert.instanceOf(error, BoardRepositoryError);
          assert.equal(error.operation, "BoardRepository.listCards:query");
        }).pipe(
          Effect.ensuring(
            Effect.all([
              repository.deleteCard(backlog.cardId),
              repository.deleteCard(other.cardId),
            ]).pipe(Effect.orDie),
          ),
        );
      }),
  );

  it.effect("labels updateCard read failures as update reads", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-update-card-read-failure");
      const card = makeCard({
        cardId: BoardCardId.make("update-card-read-failure"),
        orchestratorThreadId: threadId,
      });
      yield* seedThread(threadId);
      yield* repository.addOrchestrator({
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* repository.createCard(card);

      yield* Effect.gen(function* () {
        yield* sql`UPDATE board_cards SET status = 'invalid' WHERE card_id = ${card.cardId}`;
        const error = yield* Effect.flip(repository.updateCard(card));
        assert.instanceOf(error, BoardRepositoryError);
        assert.equal(error.operation, "BoardRepository.updateCard:read");
      }).pipe(Effect.ensuring(repository.deleteCard(card.cardId)));
    }),
  );

  it.effect("reads a legacy card row as ready after the readiness migration", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-legacy-readiness-card");
      yield* seedThread(threadId);
      yield* repository.addOrchestrator({
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const cardId = BoardCardId.make("legacy-readiness-card");
      yield* sql`
        INSERT INTO board_cards (
          card_id, orchestrator_thread_id, title, body, status, created_by,
          assignee_json, executor_role, executor_thread_id, outcome, last_error,
          failure_streak, order_index, archived, created_at, updated_at
        ) VALUES (
          ${cardId}, ${threadId}, 'Legacy row', '', 'todo', 'human',
          NULL, 'general', NULL, NULL, NULL, 0, 0, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      const card = Option.getOrThrow(yield* repository.getCard(cardId));
      assert.equal(card.title, "Legacy row");
      assert.equal(card.readiness, "ready");
      assert.isNull(card.readinessNote);
    }),
  );

  it.effect("rejects unsafe author text at the storage boundary and preserves safe bytes", () =>
    Effect.gen(function* () {
      const repository = yield* BoardRepository;
      const threadId = ThreadId.make("thread-secret-board-text");
      const secret = `ghp_${"A".repeat(32)}`;
      yield* seedThread(threadId);
      yield* repository.addOrchestrator({
        threadId,
        createdBy: "human",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      for (const unsafe of [
        makeCard({
          cardId: BoardCardId.make("unsafe-board-title"),
          orchestratorThreadId: threadId,
          title: `Unsafe title ${secret}`,
        }),
        makeCard({
          cardId: BoardCardId.make("unsafe-board-body"),
          orchestratorThreadId: threadId,
          body: `Unsafe body ${secret}`,
        }),
        makeCard({
          cardId: BoardCardId.make("unsafe-board-last-error"),
          orchestratorThreadId: threadId,
          lastError: `Unsafe error ${secret}`,
        }),
        makeCard({
          cardId: BoardCardId.make("unsafe-board-readiness-note"),
          orchestratorThreadId: threadId,
          readiness: "blocked",
          readinessNote: `Unsafe note ${secret}`,
        }),
      ]) {
        const error = yield* Effect.flip(repository.createCard(unsafe));
        assert.instanceOf(error, BoardRepositoryError);
        assert.notInclude(error.message, secret);
      }
      assert.equal(
        (yield* repository.listCards()).filter(
          (candidate) => candidate.orchestratorThreadId === threadId,
        ).length,
        0,
      );

      const safe = makeCard({
        cardId: BoardCardId.make("safe-board-text"),
        orchestratorThreadId: threadId,
        title: "Board text\r\nwith unchanged bytes",
        body: "First line.\r\nSecond line.\n",
      });
      yield* repository.createCard(safe);
      const stored = yield* repository.getCard(safe.cardId);
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.equal(stored.value.title, safe.title);
        assert.equal(stored.value.body, safe.body);
      }

      const legacy = makeCard({
        cardId: BoardCardId.make("legacy-unsafe-board-text"),
        orchestratorThreadId: threadId,
      });
      yield* repository.createCard(legacy);
      const sql = yield* SqlClient.SqlClient;
      const legacyTitle = `Inherited title ${secret}`;
      const legacyBody = `Inherited body ${secret}`;
      const legacyError = `Inherited error ${secret}`;
      yield* sql`
        UPDATE board_cards
        SET title = ${legacyTitle}, body = ${legacyBody}, last_error = ${legacyError}
        WHERE card_id = ${legacy.cardId}
      `;
      const legacyOption = yield* repository.getCard(legacy.cardId);
      assert.isTrue(Option.isSome(legacyOption));
      if (Option.isSome(legacyOption)) {
        yield* repository.updateCard({ ...legacyOption.value, status: "done" });
      }
      const statusUpdated = yield* repository.getCard(legacy.cardId);
      assert.isTrue(Option.isSome(statusUpdated));
      if (Option.isSome(statusUpdated)) {
        assert.equal(statusUpdated.value.title, legacyTitle);
        assert.equal(statusUpdated.value.body, legacyBody);
        assert.equal(statusUpdated.value.lastError, legacyError);
        assert.equal(statusUpdated.value.status, "done");
      }

      const changedUnsafeTitle = `Changed inherited title ${secret}`;
      const rejectedChangedText = yield* Effect.flip(
        repository.updateCard({
          ...Option.getOrThrow(statusUpdated),
          title: changedUnsafeTitle,
        }),
      );
      assert.instanceOf(rejectedChangedText, BoardRepositoryError);
      assert.notInclude(rejectedChangedText.message, secret);
      const afterRejectedChange = yield* repository.getCard(legacy.cardId);
      assert.isTrue(Option.isSome(afterRejectedChange));
      if (Option.isSome(afterRejectedChange)) {
        assert.equal(afterRejectedChange.value.title, legacyTitle);
      }

      for (const unsafeUpdate of [
        { ...safe, title: `Unsafe title ${secret}` },
        { ...safe, body: `Unsafe body ${secret}` },
        { ...safe, lastError: `Unsafe error ${secret}` },
        { ...safe, readiness: "blocked" as const, readinessNote: `Unsafe note ${secret}` },
      ]) {
        const error = yield* Effect.flip(repository.updateCard(unsafeUpdate));
        assert.instanceOf(error, BoardRepositoryError);
        assert.notInclude(error.message, secret);
        const unchanged = yield* repository.getCard(safe.cardId);
        assert.isTrue(Option.isSome(unchanged));
        if (Option.isSome(unchanged)) {
          assert.equal(unchanged.value.title, safe.title);
          assert.equal(unchanged.value.body, safe.body);
          assert.isNull(unchanged.value.lastError);
        }
      }
    }),
  );
});
