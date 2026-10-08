import {
  BoardCardId,
  ProjectId,
  ThreadId,
  type BoardCard,
  type BoardCardStatus,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRepositoryLive } from "./persistence/Layers/Board.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  ARCHIVE_REQUIRES_DONE_CODE,
  ARCHIVE_REQUIRES_DONE_DETAIL,
  BoardRepository,
  buildBoardCardEvent,
} from "./persistence/Services/Board.ts";
import type { McpInvocationScope } from "./mcp/McpInvocationContext.ts";
import {
  __testing,
  type OrchestratorMcpDependencies,
} from "./mcp/toolkits/orchestrator/service.ts";
import { makeBoardRpcHandlers } from "./ws.ts";

const AT = "2026-09-20T00:00:00.000Z";
const LATER = "2026-09-21T00:00:00.000Z";

const layer = it.layer(BoardRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const makeCard = (
  threadId: ThreadId,
  cardId: string,
  status: BoardCardStatus,
  overrides: Partial<BoardCard> = {},
): BoardCard => ({
  cardId: BoardCardId.make(cardId),
  orchestratorThreadId: threadId,
  title: "Archive gate",
  body: "Exercise every write door.",
  status,
  readiness: "ready",
  readinessNote: null,
  createdBy: "human",
  assignee: null,
  executorRole: "general",
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

const seedOrchestrator = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* BoardRepository;
    const threadId = ThreadId.make(`thread-${name}`);
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
    return threadId;
  });

// Legacy rows predate the rule, so they are planted below the repository.
const plantArchived = (cardId: BoardCardId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE board_cards SET archived = 1 WHERE card_id = ${cardId}`;
  });

const makeWsDoor = () =>
  Effect.gen(function* () {
    const repository = yield* BoardRepository;
    const unused = () => Effect.die("unused by board.update");
    return makeBoardRpcHandlers({
      repository,
      dispatch: unused,
      getThreadShell: unused,
      getShellSnapshot: unused,
      getArchivedShellSnapshot: unused,
      listTurns: unused,
      newId: unused,
      now: Effect.succeed(LATER),
    });
  });

const makeMcpDoor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const board = yield* BoardRepository;
    const unused = () => Effect.die("unused by boardUpdateCard");
    const dependencies = {
      board,
      now: Effect.succeed(LATER),
      getThreadShellById: () => Effect.succeed(Option.some({ delegationParent: null })),
      getProjectShellById: unused,
      getThreadDetailById: unused,
      listTurnsByThreadId: unused,
    } as unknown as OrchestratorMcpDependencies;
    const scope = {
      threadId,
      projectId: ProjectId.make("project-1"),
      capabilities: new Set(["orchestration"]),
      orchestration: {},
      issuedAt: 1,
    } as unknown as McpInvocationScope;
    return { service: __testing.makeService(dependencies), scope };
  });

// One comparable string per refusal, whatever shape the door reports it in.
const refusalText = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const { code, detail, message } = error as {
      code?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    return [code, detail, message].filter((part) => typeof part === "string").join(" | ");
  }
  return String(error);
};

const refusalOf = <A, E>(attempt: Effect.Effect<A, E>) =>
  Effect.match(attempt, {
    onFailure: refusalText,
    onSuccess: () => "the write succeeded instead of being refused",
  });

const assertArchiveRefused = (door: string, refusal: string) => {
  assert.include(refusal, ARCHIVE_REQUIRES_DONE_CODE, `${door} must name the rule`);
  assert.include(refusal, ARCHIVE_REQUIRES_DONE_DETAIL, `${door} must give the same reason`);
};

layer("archive requires a done card on every write door", (it) => {
  it.effect("refuses an unfinished card on the repository, web and MCP doors alike", () =>
    Effect.gen(function* () {
      const threadId = yield* seedOrchestrator("gate-unfinished");
      const repository = yield* BoardRepository;
      const ws = yield* makeWsDoor();
      const mcp = yield* makeMcpDoor(threadId);

      const cards = {
        repoUpdate: makeCard(threadId, "gate-repo-update", "todo"),
        repoUpdateWithPrevious: makeCard(threadId, "gate-repo-previous", "review"),
        repoUpdateWithEvent: makeCard(threadId, "gate-repo-event", "in_progress"),
        ws: makeCard(threadId, "gate-ws", "orchestrator"),
        mcp: makeCard(threadId, "gate-mcp", "backlog"),
      };
      for (const card of Object.values(cards)) yield* repository.createCard(card);

      const archived = (card: BoardCard): BoardCard => ({
        ...card,
        archived: true,
        updatedAt: LATER,
      });
      const doors: ReadonlyArray<readonly [string, BoardCard, Effect.Effect<string>]> = [
        [
          "repository.updateCard",
          cards.repoUpdate,
          refusalOf(repository.updateCard(archived(cards.repoUpdate))),
        ],
        [
          "repository.updateCardWithPrevious",
          cards.repoUpdateWithPrevious,
          refusalOf(
            repository.updateCardWithPrevious(
              archived(cards.repoUpdateWithPrevious),
              Option.some(cards.repoUpdateWithPrevious),
            ),
          ),
        ],
        [
          "repository.updateCardWithEvent",
          cards.repoUpdateWithEvent,
          refusalOf(
            repository.updateCardWithEvent(
              archived(cards.repoUpdateWithEvent),
              buildBoardCardEvent(archived(cards.repoUpdateWithEvent), { at: LATER }),
            ),
          ),
        ],
        [
          "web board.update",
          cards.ws,
          refusalOf(ws.update({ cardId: cards.ws.cardId, archived: true })),
        ],
        [
          "MCP board_update_card",
          cards.mcp,
          refusalOf(
            mcp.service.boardUpdateCard(mcp.scope, { cardId: cards.mcp.cardId, archived: true }),
          ),
        ],
      ];

      for (const [door, card, attempt] of doors) {
        assertArchiveRefused(door, yield* attempt);
        const stored = Option.getOrThrow(yield* repository.getCard(card.cardId));
        assert.deepEqual(stored, card, `${door} must leave the card untouched`);
        assert.deepEqual(
          yield* repository.listEventsForCard({ cardId: card.cardId }),
          [],
          `${door} must not record history`,
        );
      }
    }),
  );

  it.effect("refuses to create an archived unfinished card", () =>
    Effect.gen(function* () {
      const threadId = yield* seedOrchestrator("gate-create");
      const repository = yield* BoardRepository;
      const card = makeCard(threadId, "gate-create-card", "todo", { archived: true });

      assertArchiveRefused(
        "repository.createCard",
        refusalText(yield* Effect.flip(repository.createCard(card))),
      );
      assert.isTrue(Option.isNone(yield* repository.getCard(card.cardId)));
    }),
  );

  it.effect("refuses to move an archived done card back out of done", () =>
    Effect.gen(function* () {
      const threadId = yield* seedOrchestrator("gate-reopen");
      const repository = yield* BoardRepository;
      const mcp = yield* makeMcpDoor(threadId);
      const card = makeCard(threadId, "gate-reopen-card", "done", { archived: true });
      yield* repository.createCard(card);

      assertArchiveRefused(
        "repository.updateCard",
        refusalText(yield* Effect.flip(repository.updateCard({ ...card, status: "todo" }))),
      );
      // The MCP pre-check only looks at an explicit `archived: true`; the repository still stops this.
      assertArchiveRefused(
        "MCP board_update_card",
        refusalText(
          yield* Effect.flip(
            mcp.service.boardUpdateCard(mcp.scope, { cardId: card.cardId, status: "todo" }),
          ),
        ),
      );
      assert.deepEqual(Option.getOrThrow(yield* repository.getCard(card.cardId)), card);
    }),
  );

  it.effect("still archives a done card on every door", () =>
    Effect.gen(function* () {
      const threadId = yield* seedOrchestrator("gate-done");
      const repository = yield* BoardRepository;
      const ws = yield* makeWsDoor();
      const mcp = yield* makeMcpDoor(threadId);
      const cards = {
        repoUpdate: makeCard(threadId, "done-repo-update", "done"),
        repoUpdateWithPrevious: makeCard(threadId, "done-repo-previous", "done"),
        repoUpdateWithEvent: makeCard(threadId, "done-repo-event", "done"),
        ws: makeCard(threadId, "done-ws", "done"),
        mcp: makeCard(threadId, "done-mcp", "done"),
      };
      for (const card of Object.values(cards)) yield* repository.createCard(card);
      const archived = (card: BoardCard): BoardCard => ({
        ...card,
        archived: true,
        updatedAt: LATER,
      });

      yield* repository.updateCard(archived(cards.repoUpdate));
      yield* repository.updateCardWithPrevious(
        archived(cards.repoUpdateWithPrevious),
        Option.some(cards.repoUpdateWithPrevious),
      );
      yield* repository.updateCardWithEvent(
        archived(cards.repoUpdateWithEvent),
        buildBoardCardEvent(archived(cards.repoUpdateWithEvent), { at: LATER }),
      );
      yield* ws.update({ cardId: cards.ws.cardId, archived: true });
      yield* mcp.service.boardUpdateCard(mcp.scope, { cardId: cards.mcp.cardId, archived: true });

      for (const card of Object.values(cards)) {
        const stored = Option.getOrThrow(yield* repository.getCard(card.cardId));
        assert.isTrue(stored.archived, `${card.cardId} should be archived`);
        assert.strictEqual(stored.status, "done");
      }
    }),
  );

  it.effect(
    "leaves an already archived unfinished card alone and still lets it be unarchived",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seedOrchestrator("gate-legacy");
        const repository = yield* BoardRepository;
        const ws = yield* makeWsDoor();
        const legacy = makeCard(threadId, "gate-legacy-card", "todo");
        yield* repository.createCard(legacy);
        yield* plantArchived(legacy.cardId);
        const planted = Option.getOrThrow(yield* repository.getCard(legacy.cardId));
        assert.isTrue(planted.archived);
        assert.strictEqual(planted.status, "todo");

        // An unrelated write does not trip over the legacy row.
        yield* repository.updateCard({ ...planted, failureStreak: 1, updatedAt: LATER });
        const touched = Option.getOrThrow(yield* repository.getCard(legacy.cardId));
        assert.isTrue(touched.archived);
        assert.strictEqual(touched.status, "todo");
        assert.strictEqual(touched.failureStreak, 1);

        // Unarchiving is the way out and is never blocked.
        const restored = yield* ws.update({ cardId: legacy.cardId, archived: false });
        assert.isFalse(restored.archived);
      }),
  );
});
