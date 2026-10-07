import {
  BoardCardEventId,
  BoardCardId,
  BoardCardLookupToken,
  BoardError,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type BoardCard,
  type BoardCardEvent,
  type BoardOrchestrator,
  type BoardUpdateInput,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BoardRepositoryShape } from "./persistence/Services/Board.ts";
import type { ProjectionTurn } from "./persistence/Services/ProjectionTurns.ts";
import { BOARD_ORCHESTRATOR_TURN_TEXT } from "./orchestration/boardWakePrompt.ts";
import { makeBoardRpcHandlers, type BoardRpcDependencies } from "./ws.ts";

const ORCHESTRATOR = ThreadId.make("orch-thread");
const CHILD = ThreadId.make("child-thread");
const ARCHITECT = ThreadId.make("arch:board-rpc-denied");
const AT = "2026-09-20T00:00:00.000Z";
const SECRET = `ghp_${"A".repeat(32)}`;

describe("Phase 1 board RPC compatibility", () => {
  it("keeps the existing board orchestrator RPC names", () => {
    assert.strictEqual(WS_METHODS.boardOrchestratorsList, "board.orchestrators.list");
    assert.strictEqual(WS_METHODS.boardOrchestratorAdd, "board.orchestrator.add");
    assert.strictEqual(WS_METHODS.boardOrchestratorRemove, "board.orchestrator.remove");
    assert.strictEqual(WS_METHODS.boardOrchestratorResendBrief, "board.orchestrator.resendBrief");
  });
});

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    cardId: BoardCardId.make("card-1"),
    orchestratorThreadId: ORCHESTRATOR,
    title: "Wire the board",
    body: "Connect the RPC handlers.",
    status: "todo",
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
  };
}

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ORCHESTRATOR,
    status,
    providerName: "codex",
    activeTurnId: null,
    runtimeMode: "full-access",
    lastError: null,
    updatedAt: AT,
  };
}

function makeThread(
  overrides: Partial<OrchestrationThreadShell> & { id: ThreadId },
): OrchestrationThreadShell {
  return {
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

interface FakeBoardState {
  cards: BoardCard[];
  events: BoardCardEvent[];
  orchestrators: BoardOrchestrator[];
  prefixQueries: string[];
}

function makeFakeRepository(state: FakeBoardState): BoardRepositoryShape {
  return {
    listOrchestrators: () => Effect.succeed(state.orchestrators),
    addOrchestrator: (input) => {
      state.orchestrators.push({ ...input });
      return Effect.succeed({ ...input });
    },
    removeOrchestrator: (threadId) => {
      state.orchestrators = state.orchestrators.filter((row) => row.threadId !== threadId);
      return Effect.void;
    },
    listCards: () => Effect.succeed(state.cards),
    findCardsByPrefix: (prefix) => {
      state.prefixQueries.push(prefix);
      return Effect.succeed(
        state.cards
          .filter((card) => String(card.cardId).toLowerCase().startsWith(prefix))
          .slice(0, 2),
      );
    },
    getCard: (cardId) =>
      Effect.succeed(Option.fromNullishOr(state.cards.find((card) => card.cardId === cardId))),
    findCardByExecutor: (threadId) =>
      Effect.succeed(
        Option.fromNullishOr(state.cards.find((card) => card.executorThreadId === threadId)),
      ),
    listCardsByExecutor: (threadId) =>
      Effect.succeed(state.cards.filter((card) => card.executorThreadId === threadId)),
    createCard: (card) => {
      state.cards.push(card);
      return Effect.void;
    },
    updateCard: (card) => {
      state.cards = state.cards.map((row) => (row.cardId === card.cardId ? card : row));
      return Effect.void;
    },
    updateCardWithPrevious: (card) => {
      state.cards = state.cards.map((row) => (row.cardId === card.cardId ? card : row));
      return Effect.void;
    },
    deleteCard: (cardId) => {
      state.cards = state.cards.filter((card) => card.cardId !== cardId);
      return Effect.void;
    },
    listEvents: () => Effect.succeed(state.events),
    listEventsForCard: ({ cardId, limit }) => {
      const events = state.events
        .filter((event) => event.cardId === cardId)
        .toSorted((left, right) =>
          limit === undefined
            ? left.at.localeCompare(right.at) || left.entryId.localeCompare(right.entryId)
            : right.at.localeCompare(left.at) || right.entryId.localeCompare(left.entryId),
        );
      return Effect.succeed(limit === undefined ? events : events.slice(0, limit));
    },
    appendEvent: (event) => {
      state.events.push(event);
      return Effect.void;
    },
    listArchiveCandidates: () => Effect.succeed([]),
    listDeleteCandidates: () => Effect.succeed([]),
    updateCardWithEvent: (card, event) => {
      state.cards = state.cards.map((row) => (row.cardId === card.cardId ? card : row));
      state.events.push(event);
      return Effect.void;
    },
    deleteCardWithRecord: ({ cardId }) => {
      state.cards = state.cards.filter((card) => card.cardId !== cardId);
      return Effect.void;
    },
    listDeletionRecords: () => Effect.succeed([]),
  };
}

interface Harness {
  readonly handlers: ReturnType<typeof makeBoardRpcHandlers>;
  readonly state: FakeBoardState;
  readonly dispatched: OrchestrationCommand[];
}

function makeHarness(
  options: {
    cards?: ReadonlyArray<BoardCard>;
    events?: ReadonlyArray<BoardCardEvent>;
    shells?: ReadonlyArray<OrchestrationThreadShell>;
    archivedShells?: ReadonlyArray<OrchestrationThreadShell>;
    turns?: ReadonlyArray<ProjectionTurn>;
  } = {},
): Harness {
  const state: FakeBoardState = {
    cards: [...(options.cards ?? [])],
    events: [...(options.events ?? [])],
    orchestrators: [],
    prefixQueries: [],
  };
  const dispatched: OrchestrationCommand[] = [];
  let nextId = 0;
  // Mirrors the engine command receipt: a repeated commandId is a no-op.
  const commandReceipts = new Set<string>();
  const shells = new Map(
    [...(options.shells ?? []), ...(options.archivedShells ?? [])].map((thread) => [
      thread.id,
      thread,
    ]),
  );
  const snapshot = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): OrchestrationShellSnapshot => ({
    snapshotSequence: 0,
    projects: [],
    threads,
    updatedAt: AT,
  });
  const deps: BoardRpcDependencies = {
    repository: makeFakeRepository(state),
    dispatch: (command) => {
      if (!commandReceipts.has(command.commandId)) {
        commandReceipts.add(command.commandId);
        dispatched.push(command);
      }
      return Effect.succeed({ sequence: dispatched.length });
    },
    getThreadShell: (threadId) => Effect.succeed(Option.fromNullishOr(shells.get(threadId))),
    getShellSnapshot: () => Effect.succeed(snapshot(options.shells ?? [])),
    getArchivedShellSnapshot: () => Effect.succeed(snapshot(options.archivedShells ?? [])),
    listTurns: () => Effect.succeed(options.turns ?? []),
    isArchitectThread: (threadId) => Effect.succeed(threadId === ARCHITECT),
    newId: () => {
      nextId += 1;
      return Effect.succeed(nextId === 1 ? "generated-id" : `generated-id-${nextId}`);
    },
    now: Effect.succeed(AT),
  };
  return { handlers: makeBoardRpcHandlers(deps), state, dispatched };
}

const messageIdOf = (command: OrchestrationCommand): string | null =>
  command.type === "thread.message.system.append" ? command.message.messageId : null;

describe("board RPC handlers", () => {
  it.effect("list returns cards together with their progress history", () =>
    Effect.gen(function* () {
      const card = makeCard();
      const event: BoardCardEvent = {
        entryId: BoardCardEventId.make("entry-1"),
        cardId: card.cardId,
        at: AT,
        status: "todo",
        executorRole: "general",
        model: null,
        effort: null,
        source: "system",
      };
      const { handlers } = makeHarness({ cards: [card], events: [event] });

      const result = yield* handlers.list({});

      assert.strictEqual(result.cards.length, 1);
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0]?.cardId, card.cardId);
    }),
  );

  it.effect("create stamps a human todo card and appends a history entry", () =>
    Effect.gen(function* () {
      const { handlers, state } = makeHarness();
      const title = "New task\r\nwith an internal line";
      const body = "Do it.\r\nPreserve the line endings.\n";

      const card = yield* handlers.create({
        orchestratorThreadId: ORCHESTRATOR,
        title,
        body,
        executorRole: "implementation",
      });

      assert.strictEqual(card.status, "todo");
      assert.strictEqual(card.createdBy, "human");
      assert.strictEqual(card.executorThreadId, null);
      assert.strictEqual(card.title, title);
      assert.strictEqual(card.body, body);
      assert.strictEqual(card.cardId, BoardCardId.make("generated-id"));
      assert.strictEqual(state.cards.length, 1);
      assert.strictEqual(state.events.length, 1);
      assert.strictEqual(state.events[0]?.cardId, card.cardId);
    }),
  );

  it.effect("rejects unsafe card text before create writes", () =>
    Effect.gen(function* () {
      const { handlers, state } = makeHarness();

      for (const input of [
        { title: `Unsafe ${SECRET}`, body: "Safe body." },
        { title: "Safe title", body: `Unsafe ${SECRET}` },
      ]) {
        const error = yield* Effect.flip(
          handlers.create({
            orchestratorThreadId: ORCHESTRATOR,
            ...input,
            executorRole: "implementation",
          }),
        );
        assert.instanceOf(error, BoardError);
        assert.notInclude(error.detail, SECRET);
        assert.strictEqual(state.cards.length, 0);
        assert.strictEqual(state.events.length, 0);
      }
    }),
  );

  it.effect("start moves todo to orchestrator, notifies, and wakes an idle orchestrator", () =>
    Effect.gen(function* () {
      const card = makeCard();
      const { handlers, state, dispatched } = makeHarness({
        cards: [card],
        shells: [makeThread({ id: ORCHESTRATOR })],
      });

      const started = yield* handlers.start({ cardId: card.cardId });

      assert.strictEqual(started.status, "orchestrator");
      assert.strictEqual(state.cards[0]?.status, "orchestrator");
      assert.strictEqual(state.events.length, 1);
      const notice = dispatched.find(
        (command) => messageIdOf(command) === `board-start:${card.cardId}`,
      );
      assert.isDefined(notice);
      const wake = dispatched.find(
        (command) =>
          command.type === "thread.turn.start" &&
          command.message.messageId === `board-start-turn:${card.cardId}`,
      );
      assert.isDefined(wake);
      if (notice?.type === "thread.message.system.append" && wake?.type === "thread.turn.start") {
        assert.strictEqual(wake.message.text, notice.message.text);
        assert.include(wake.message.text, card.title);
        assert.include(wake.message.text, card.body);
      }
    }),
  );

  it.effect("start while busy still delivers the task notice but starts no turn", () =>
    Effect.gen(function* () {
      const card = makeCard();
      const { handlers, dispatched } = makeHarness({
        cards: [card],
        shells: [makeThread({ id: ORCHESTRATOR, session: makeSession("running") })],
      });

      yield* handlers.start({ cardId: card.cardId });

      assert.isTrue(dispatched.some((command) => messageIdOf(command) !== null));
      assert.isFalse(dispatched.some((command) => command.type === "thread.turn.start"));
    }),
  );

  it.effect(
    "start pulls a backlog card into orchestrator, notifies, and wakes the orchestrator",
    () =>
      Effect.gen(function* () {
        const card = makeCard({ status: "backlog" });
        const { handlers, state, dispatched } = makeHarness({
          cards: [card],
          shells: [makeThread({ id: ORCHESTRATOR })],
        });

        const started = yield* handlers.start({ cardId: card.cardId });

        assert.strictEqual(started.status, "orchestrator");
        assert.strictEqual(state.cards[0]?.status, "orchestrator");
        assert.strictEqual(state.events.length, 1);
        assert.isDefined(
          dispatched.find((command) => messageIdOf(command) === `board-start:${card.cardId}`),
        );
        assert.isDefined(
          dispatched.find(
            (command) =>
              command.type === "thread.turn.start" &&
              command.message.messageId === `board-start-turn:${card.cardId}`,
          ),
        );
      }),
  );

  it.effect("start rejects an archived backlog card", () =>
    Effect.gen(function* () {
      const card = makeCard({ status: "backlog", archived: true });
      const { handlers, state, dispatched } = makeHarness({ cards: [card] });

      const error = yield* Effect.flip(handlers.start({ cardId: card.cardId }));

      assert.instanceOf(error, BoardError);
      assert.include(error.detail, "Archived board card");
      assert.strictEqual(state.cards[0]?.status, "backlog");
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("human update still cannot change status, including into or out of backlog", () =>
    Effect.gen(function* () {
      for (const [from, to] of [
        ["todo", "backlog"],
        ["backlog", "todo"],
      ] as const) {
        const card = makeCard({ status: from });
        const { handlers, state } = makeHarness({ cards: [card] });

        const error = yield* Effect.flip(handlers.update({ cardId: card.cardId, status: to }));

        assert.instanceOf(error, BoardError);
        assert.include(error.detail, "may only change 'archived'");
        assert.strictEqual(state.cards[0]?.status, from);
        assert.strictEqual(state.events.length, 0);
      }
    }),
  );

  it.effect("start rejects a card that is not todo or backlog", () =>
    Effect.gen(function* () {
      const card = makeCard({ status: "review" });
      const { handlers, state, dispatched } = makeHarness({ cards: [card] });

      const error = yield* Effect.flip(handlers.start({ cardId: card.cardId }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.start");
      assert.strictEqual(state.cards[0]?.status, "review");
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("start rejects an archived todo card", () =>
    Effect.gen(function* () {
      const card = makeCard({ archived: true });
      const { handlers, state, dispatched } = makeHarness({ cards: [card] });

      const error = yield* Effect.flip(handlers.start({ cardId: card.cardId }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.start");
      assert.include(error.detail, "Archived board card");
      assert.strictEqual(state.cards[0]?.status, "todo");
      assert.isTrue(state.cards[0]?.archived);
      assert.strictEqual(state.events.length, 0);
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("resolves only unique prefixes and exact UUIDs, and returns card-scoped history", () =>
    Effect.gen(function* () {
      const uniqueId = BoardCardId.make("b71111aa-0000-4000-8000-000000000001");
      const ambiguousId1 = BoardCardId.make("c0ffee42-0000-4000-8000-000000000001");
      const ambiguousId2 = BoardCardId.make("c0ffee42-0000-4000-8000-000000000002");
      const unique = makeCard({ cardId: uniqueId });
      const cards = [
        unique,
        makeCard({ cardId: ambiguousId1, title: "Ambiguous one" }),
        makeCard({ cardId: ambiguousId2, title: "Ambiguous two" }),
      ];
      const history = Array.from({ length: 4 }, (_, index): BoardCardEvent => ({
        entryId: BoardCardEventId.make(`unique-entry-${index}`),
        cardId: uniqueId,
        at: `2026-09-20T00:00:0${index}.000Z`,
        status: "todo",
        executorRole: "general",
        model: null,
        effort: null,
        source: "system",
      }));
      const { handlers } = makeHarness({
        cards,
        events: history,
        shells: [makeThread({ id: ORCHESTRATOR, title: "Owning chat" })],
      });

      const result = yield* handlers.resolve({
        tokens: [
          BoardCardLookupToken.make("b71111aa"),
          BoardCardLookupToken.make("c0ffee42"),
          BoardCardLookupToken.make("ffffffff"),
          BoardCardLookupToken.make(String(uniqueId)),
        ],
        cardIds: [uniqueId, BoardCardId.make("ffffffff-0000-4000-8000-000000000000")],
      });

      assert.deepEqual(
        result.matches.map((match) => match.token),
        ["b71111aa", String(uniqueId)],
      );
      assert.strictEqual(result.matches[0]?.card.cardId, uniqueId);
      assert.strictEqual(result.matches[0]?.orchestratorThreadTitle, "Owning chat");
      assert.strictEqual(result.matches[0]?.recentEvents.length, 3);
      assert.deepEqual(
        result.matches[0]?.recentEvents.map((event) => event.entryId),
        ["unique-entry-1", "unique-entry-2", "unique-entry-3"],
      );
      assert.strictEqual(result.details.length, 1);
      assert.strictEqual(result.details[0]?.events.length, 4);
    }),
  );

  it.effect("resolves a full UUID by exact match only and a prefix only when unique", () =>
    Effect.gen(function* () {
      const idA = BoardCardId.make("cb37d411-840c-4c70-8fe7-240b1ddc6a10");
      const idB = BoardCardId.make("cb37d411-0000-4000-8000-000000000002");
      const { handlers, state } = makeHarness({
        cards: [makeCard({ cardId: idA }), makeCard({ cardId: idB })],
      });

      const exact = yield* handlers.resolve({
        tokens: [BoardCardLookupToken.make(String(idA).toUpperCase())],
        cardIds: [],
      });
      assert.deepEqual(
        exact.matches.map((match) => match.card.cardId),
        [idA],
      );
      assert.deepEqual(state.prefixQueries, []);

      const absent = yield* handlers.resolve({
        tokens: [BoardCardLookupToken.make("cb37d411-840c-4c70-8fe7-240b1ddc6a11")],
        cardIds: [],
      });
      assert.deepEqual(absent.matches, []);
      assert.deepEqual(state.prefixQueries, []);

      const ambiguous = yield* handlers.resolve({
        tokens: [BoardCardLookupToken.make("cb37d411")],
        cardIds: [],
      });
      assert.deepEqual(ambiguous.matches, []);
      assert.deepEqual(state.prefixQueries, ["cb37d411"]);
    }),
  );

  it.effect("omits a retention-deleted card from resolve without failing", () =>
    Effect.gen(function* () {
      const deletedId = BoardCardId.make("d3adbeef-0000-4000-8000-000000000001");
      const { handlers } = makeHarness({ cards: [], events: [] });

      const result = yield* handlers.resolve({
        tokens: [
          BoardCardLookupToken.make("d3adbeef"),
          BoardCardLookupToken.make(String(deletedId)),
        ],
        cardIds: [deletedId],
      });

      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.details, []);
    }),
  );

  it.effect("does not start unsafe legacy cards or notify their orchestrator", () =>
    Effect.gen(function* () {
      for (const card of [
        makeCard({ title: `Unsafe ${SECRET}` }),
        makeCard({ body: `Unsafe ${SECRET}` }),
        makeCard({ lastError: `Unsafe ${SECRET}` }),
      ]) {
        const { handlers, state, dispatched } = makeHarness({
          cards: [card],
          shells: [makeThread({ id: ORCHESTRATOR })],
        });

        const error = yield* Effect.flip(handlers.start({ cardId: card.cardId }));

        assert.instanceOf(error, BoardError);
        assert.strictEqual(error.operation, "board.start");
        assert.notInclude(error.detail, SECRET);
        assert.strictEqual(state.cards[0]?.status, "todo");
        assert.strictEqual(state.events.length, 0);
        assert.strictEqual(dispatched.length, 0);
      }
    }),
  );

  it.effect("update rejects orchestrator-owned fields without writing history", () =>
    Effect.gen(function* () {
      const card = makeCard({ status: "orchestrator" });
      const { handlers, state } = makeHarness({ cards: [card] });

      const error = yield* Effect.flip(handlers.update({ cardId: card.cardId, status: "review" }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.update");
      assert.strictEqual(state.cards[0]?.status, "orchestrator");
      assert.strictEqual(state.events.length, 0);
    }),
  );

  it.effect("update archives and unarchives a card with an append-only history row", () =>
    Effect.gen(function* () {
      const card = makeCard({ status: "orchestrator" });
      const { handlers, state } = makeHarness({ cards: [card] });

      const updated = yield* handlers.update({ cardId: card.cardId, archived: true });
      const unarchived = yield* handlers.update({ cardId: card.cardId, archived: false });

      assert.isTrue(updated.archived);
      assert.isFalse(unarchived.archived);
      assert.isFalse(state.cards[0]?.archived ?? true);
      assert.deepEqual(
        state.events.map((event) => event.body),
        ["archived by human", "unarchived by human"],
      );
    }),
  );

  it.effect("human board.update cannot change readiness", () =>
    Effect.gen(function* () {
      const card = makeCard();
      const { handlers, state } = makeHarness({ cards: [card] });
      const attemptedUpdate = {
        cardId: card.cardId,
        readiness: "blocked",
        readinessNote: "Waiting on a human",
      } as unknown as BoardUpdateInput;

      const updated = yield* handlers.update(attemptedUpdate);

      assert.strictEqual(updated.readiness, "ready");
      assert.isNull(updated.readinessNote);
      assert.strictEqual(state.events.length, 0);
    }),
  );

  it.effect("board.update preserves legacy unsafe text when archiving", () =>
    Effect.gen(function* () {
      const card = makeCard({
        title: `Legacy title ${SECRET}`,
        body: `Legacy body ${SECRET}`,
        lastError: `Legacy error ${SECRET}`,
      });
      const { handlers, state } = makeHarness({ cards: [card] });

      const updated = yield* handlers.update({ cardId: card.cardId, archived: true });

      assert.isTrue(updated.archived);
      assert.strictEqual(updated.title, card.title);
      assert.strictEqual(updated.body, card.body);
      assert.strictEqual(updated.lastError, card.lastError);
      assert.deepEqual(
        state.events.map((event) => event.body),
        ["archived by human"],
      );
    }),
  );

  it.effect("delete is always refused for human clients", () =>
    Effect.gen(function* () {
      const card = makeCard();
      const { handlers, state } = makeHarness({ cards: [card] });

      const error = yield* Effect.flip(handlers.delete({ cardId: card.cardId }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.delete");
      assert.include(error.detail, "the Coordinator deletes cards through MCP");
      assert.strictEqual(state.cards.length, 1);
    }),
  );

  it.effect("orchestrator.add refuses a delegated child thread", () =>
    Effect.gen(function* () {
      const { handlers, state } = makeHarness({
        shells: [
          makeThread({
            id: CHILD,
            delegationParent: {
              parentThreadId: ORCHESTRATOR,
              parentEnvironmentId: "env-1",
              role: "general",
            },
          }),
        ],
      });

      const error = yield* Effect.flip(handlers.orchestratorAdd({ threadId: CHILD }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.orchestrator.add");
      assert.include(error.detail, "cannot be a board Coordinator");
      assert.strictEqual(state.orchestrators.length, 0);
    }),
  );

  it.effect("orchestrator.add and resendBrief deny Architect threads without side effects", () =>
    Effect.gen(function* () {
      const { handlers, state, dispatched } = makeHarness({
        shells: [makeThread({ id: ARCHITECT })],
      });
      const addError = yield* Effect.flip(handlers.orchestratorAdd({ threadId: ARCHITECT }));
      assert.instanceOf(addError, BoardError);
      assert.strictEqual(addError.operation, "board.orchestrator.add");
      assert.strictEqual(state.orchestrators.length, 0);
      assert.strictEqual(dispatched.length, 0);

      state.orchestrators.push({ threadId: ARCHITECT, createdBy: "human", createdAt: AT });
      const resendError = yield* Effect.flip(handlers.resendBrief({ threadId: ARCHITECT }));
      assert.instanceOf(resendError, BoardError);
      assert.strictEqual(resendError.operation, "board.orchestrator.resendBrief");
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("orchestrator.add marks a non-child thread", () =>
    Effect.gen(function* () {
      const { handlers, state } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR })],
      });

      const created = yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });

      assert.strictEqual(created.threadId, ORCHESTRATOR);
      assert.strictEqual(created.createdBy, "human");
      assert.strictEqual(state.orchestrators.length, 1);
    }),
  );

  it.effect("orchestrator.add briefs an idle thread and wakes it", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR })],
      });

      yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });

      const notice = dispatched.find((command) =>
        (messageIdOf(command) ?? "").startsWith(`board-orchestrator:${ORCHESTRATOR}:`),
      );
      assert.isDefined(notice);
      assert.strictEqual(notice?.type, "thread.message.system.append");
      if (notice?.type === "thread.message.system.append") {
        assert.strictEqual(notice.message.text, BOARD_ORCHESTRATOR_TURN_TEXT);
      }
      const wake = dispatched.find(
        (command) =>
          command.type === "thread.turn.start" &&
          command.message.messageId.startsWith(`board-orchestrator-turn:${ORCHESTRATOR}:`),
      );
      assert.isDefined(wake);
      if (wake?.type === "thread.turn.start") {
        assert.strictEqual(wake.message.text, BOARD_ORCHESTRATOR_TURN_TEXT);
        for (const instruction of [
          "already carries the affected card's context",
          "after a restart and before a decision",
          "board_create_card",
          "delegate_task",
          "orchestrator_capabilities",
          "board_update_card",
          "childThreadId",
          "executorThreadId",
          "todo -> orchestrator -> in_progress -> review -> done",
          "board_delete_card",
        ]) {
          assert.include(wake.message.text, instruction);
        }
        assert.notInclude(wake.message.text, "notice above");
        assert.notInclude(wake.message.text, ".agents/skills/");
      }
    }),
  );

  it.effect("orchestrator.add is idempotent for the briefing and its wake turn", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR })],
      });

      yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });
      yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });

      assert.strictEqual(
        dispatched.filter((command) =>
          (messageIdOf(command) ?? "").startsWith(`board-orchestrator:${ORCHESTRATOR}:`),
        ).length,
        1,
      );
      assert.strictEqual(
        dispatched.filter(
          (command) =>
            command.type === "thread.turn.start" &&
            command.message.messageId.startsWith(`board-orchestrator-turn:${ORCHESTRATOR}:`),
        ).length,
        1,
      );
    }),
  );

  it.effect("orchestrator.add after remove re-briefs and wakes the thread again", () =>
    Effect.gen(function* () {
      const { handlers, state, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR })],
      });

      yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });
      yield* handlers.orchestratorRemove({ threadId: ORCHESTRATOR });
      yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });

      const notices = dispatched.filter((command) =>
        (messageIdOf(command) ?? "").startsWith(`board-orchestrator:${ORCHESTRATOR}:`),
      );
      assert.strictEqual(notices.length, 2);
      assert.notStrictEqual(messageIdOf(notices[0]!), messageIdOf(notices[1]!));

      const turns = dispatched.filter(
        (command) =>
          command.type === "thread.turn.start" &&
          command.message.messageId.startsWith(`board-orchestrator-turn:${ORCHESTRATOR}:`),
      );
      assert.strictEqual(turns.length, 2);
      assert.strictEqual(state.orchestrators.length, 1);
    }),
  );

  it.effect("orchestrator.add while busy briefs but starts no turn", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR, session: makeSession("running") })],
      });

      yield* handlers.orchestratorAdd({ threadId: ORCHESTRATOR });

      assert.isDefined(
        dispatched.find((command) =>
          (messageIdOf(command) ?? "").startsWith(`board-orchestrator:${ORCHESTRATOR}:`),
        ),
      );
      assert.isFalse(dispatched.some((command) => command.type === "thread.turn.start"));
    }),
  );

  it.effect("orchestrator.resendBrief refuses a thread that is not an orchestrator", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR })],
      });

      const error = yield* Effect.flip(handlers.resendBrief({ threadId: ORCHESTRATOR }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.orchestrator.resendBrief");
      assert.include(error.detail, "is not a registered Coordinator");
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("orchestrator.resendBrief refuses a delegated child thread", () =>
    Effect.gen(function* () {
      const { handlers, state, dispatched } = makeHarness({
        shells: [
          makeThread({
            id: CHILD,
            delegationParent: {
              parentThreadId: ORCHESTRATOR,
              parentEnvironmentId: "env-1",
              role: "general",
            },
          }),
        ],
      });
      state.orchestrators.push({ threadId: CHILD, createdBy: "human", createdAt: AT });

      const error = yield* Effect.flip(handlers.resendBrief({ threadId: CHILD }));

      assert.instanceOf(error, BoardError);
      assert.strictEqual(error.operation, "board.orchestrator.resendBrief");
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("orchestrator.resendBrief re-appends a unique brief and wakes an idle thread", () =>
    Effect.gen(function* () {
      const { handlers, state, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR })],
      });
      state.orchestrators.push({ threadId: ORCHESTRATOR, createdBy: "human", createdAt: AT });

      yield* handlers.resendBrief({ threadId: ORCHESTRATOR });
      yield* handlers.resendBrief({ threadId: ORCHESTRATOR });

      const notices = dispatched.filter((command) =>
        (messageIdOf(command) ?? "").startsWith(`board-orchestrator:${ORCHESTRATOR}:`),
      );
      assert.strictEqual(notices.length, 2);
      assert.notStrictEqual(messageIdOf(notices[0]!), messageIdOf(notices[1]!));
      assert.isTrue(
        notices.every(
          (command) =>
            command.type === "thread.message.system.append" &&
            command.message.text === BOARD_ORCHESTRATOR_TURN_TEXT,
        ),
      );
      const turns = dispatched.filter(
        (command) =>
          command.type === "thread.turn.start" &&
          command.message.messageId.startsWith(`board-orchestrator-turn:${ORCHESTRATOR}:`),
      );
      assert.strictEqual(turns.length, 2);
      assert.isTrue(
        turns.every(
          (command) =>
            command.type === "thread.turn.start" &&
            command.message.text === BOARD_ORCHESTRATOR_TURN_TEXT,
        ),
      );
    }),
  );

  it.effect("orchestrator.resendBrief while busy briefs but starts no turn", () =>
    Effect.gen(function* () {
      const { handlers, state, dispatched } = makeHarness({
        shells: [makeThread({ id: ORCHESTRATOR, session: makeSession("running") })],
      });
      state.orchestrators.push({ threadId: ORCHESTRATOR, createdBy: "human", createdAt: AT });

      yield* handlers.resendBrief({ threadId: ORCHESTRATOR });

      assert.isTrue(
        dispatched.some((command) =>
          (messageIdOf(command) ?? "").startsWith(`board-orchestrator:${ORCHESTRATOR}:`),
        ),
      );
      assert.isFalse(dispatched.some((command) => command.type === "thread.turn.start"));
    }),
  );

  it.effect("orchestrator.remove deletes executor child threads", () =>
    Effect.gen(function* () {
      const { handlers, state, dispatched } = makeHarness({
        shells: [
          makeThread({
            id: CHILD,
            delegationParent: {
              parentThreadId: ORCHESTRATOR,
              parentEnvironmentId: "env-1",
              role: "implementation",
            },
          }),
        ],
      });
      state.orchestrators.push({ threadId: ORCHESTRATOR, createdBy: "human", createdAt: AT });

      yield* handlers.orchestratorRemove({ threadId: ORCHESTRATOR });

      assert.strictEqual(state.orchestrators.length, 0);
      const deleted = dispatched.filter((command) => command.type === "thread.delete");
      assert.strictEqual(deleted.length, 1);
      assert.strictEqual(deleted[0]?.type === "thread.delete" ? deleted[0].threadId : null, CHILD);
    }),
  );
});
