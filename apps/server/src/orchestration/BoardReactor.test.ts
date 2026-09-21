import {
  BoardCardId,
  ProviderInstanceId,
  ProjectId,
  type BoardCard,
  type BoardCardEvent,
  type BoardOrchestrator,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { BoardRepository } from "../persistence/Services/Board.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import * as BoardReactor from "./BoardReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-09-20T12:00:00.000Z";
const ORCHESTRATOR_ID = ThreadId.make("orchestrator-1");
const EXECUTOR_ID = ThreadId.make("executor-1");

type TerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    cardId: BoardCardId.make("card-1"),
    orchestratorThreadId: ORCHESTRATOR_ID,
    title: "Ship the board",
    body: "Implement the reactor",
    status: "in_progress",
    createdBy: "orchestrator",
    assignee: null,
    executorRole: "implementation",
    executorThreadId: EXECUTOR_ID,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: 0,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSession(
  threadId: ThreadId,
  status: OrchestrationSession["status"],
): OrchestrationSession {
  return {
    threadId,
    status,
    providerName: "codex",
    activeTurnId: null,
    runtimeMode: "full-access",
    lastError: null,
    updatedAt: NOW,
  };
}

function makeShell(
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
    createdAt: NOW,
    updatedAt: NOW,
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

function terminalEvent(input: {
  readonly childThreadId?: ThreadId;
  readonly status: TerminalStatus;
  readonly terminalError?: string;
  readonly delegatedTurnId?: string;
}): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("event-1"),
    aggregateKind: "thread",
    aggregateId: ORCHESTRATOR_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId: ORCHESTRATOR_ID,
      activity: {
        id: EventId.make("activity-1"),
        tone: "info",
        kind: "delegation.completed",
        summary: "Delegated child completed",
        payload: {
          version: 1,
          childThreadId: input.childThreadId ?? EXECUTOR_ID,
          delegatedTurnId: TurnId.make(input.delegatedTurnId ?? "turn-1"),
          status: input.status,
          completedAt: NOW,
          ...(input.terminalError === undefined ? {} : { terminalError: input.terminalError }),
        },
        turnId: null,
        createdAt: NOW,
      },
    },
  };
}

function threadDeletedEvent(threadId: ThreadId): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.make("event-2"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: { threadId, deletedAt: NOW },
  };
}

function makeHarness(
  seed: {
    readonly cards?: ReadonlyArray<BoardCard>;
    readonly shells?: ReadonlyArray<OrchestrationThreadShell>;
    readonly turns?: ReadonlyArray<ProjectionTurn>;
  } = {},
) {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const cards = yield* Ref.make<ReadonlyArray<BoardCard>>(seed.cards ?? []);
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>(seed.shells ?? []);
    const turns = yield* Ref.make<ReadonlyArray<ProjectionTurn>>(seed.turns ?? []);
    const orchestrators = yield* Ref.make<ReadonlyArray<BoardOrchestrator>>([
      { threadId: ORCHESTRATOR_ID, createdBy: "human", createdAt: NOW },
    ]);
    const updates = yield* Ref.make<ReadonlyArray<BoardCard>>([]);
    const appends = yield* Ref.make<ReadonlyArray<BoardCardEvent>>([]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const reads = yield* Queue.unbounded<void>();

    const board = Layer.mock(BoardRepository)({
      // Offering on every read lets a test await one full handler pass without sleeps.
      listOrchestrators: () =>
        Ref.get(orchestrators).pipe(Effect.tap(() => Queue.offer(reads, undefined))),
      removeOrchestrator: (threadId) =>
        Ref.update(orchestrators, (all) => all.filter((entry) => entry.threadId !== threadId)).pipe(
          Effect.andThen(Ref.set(cards, [])),
        ),
      listCards: () => Ref.get(cards).pipe(Effect.tap(() => Queue.offer(reads, undefined))),
      updateCard: (card) =>
        Ref.update(updates, (all) => [...all, card]).pipe(
          Effect.andThen(
            Ref.update(cards, (all) =>
              all.map((current) => (current.cardId === card.cardId ? card : current)),
            ),
          ),
        ),
      appendEvent: (event) => Ref.update(appends, (all) => [...all, event]),
    });

    const engine = Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
    });

    const snapshot = Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(shells).pipe(
          Effect.map((all) => Option.fromNullishOr(all.find((thread) => thread.id === threadId))),
        ),
    });

    const turnRepository = Layer.mock(ProjectionTurnRepository)({
      listByThreadId: ({ threadId }) =>
        Ref.get(turns).pipe(Effect.map((all) => all.filter((turn) => turn.threadId === threadId))),
    });

    return {
      cards,
      orchestrators,
      updates,
      appends,
      commands,
      publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
      processed: reads,
      layer: BoardReactor.layer.pipe(
        Layer.provide(Layer.mergeAll(board, engine, snapshot, turnRepository)),
      ),
    };
  });
}

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const handle = (fixture: Harness, event: OrchestrationEvent) =>
  Effect.gen(function* () {
    const reactor = yield* BoardReactor.BoardReactor;
    yield* fixture.publish(event);
    yield* Queue.take(fixture.processed);
    yield* reactor.drain;
  });

interface ScenarioSeed {
  readonly cards?: ReadonlyArray<BoardCard>;
  readonly shells?: ReadonlyArray<OrchestrationThreadShell>;
  readonly turns?: ReadonlyArray<ProjectionTurn>;
}

const runScenario = (
  seed: ScenarioSeed,
  body: (fixture: Harness) => Effect.Effect<void, never, BoardReactor.BoardReactor>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeHarness(seed);
      yield* Effect.gen(function* () {
        const reactor = yield* BoardReactor.BoardReactor;
        yield* reactor.start();
        // Wait for the forked startup recovery sweep to read the board and
        // finish, so the body and `handle`'s per-event sync start clean.
        yield* Queue.take(fixture.processed);
        yield* reactor.drain;
        yield* body(fixture);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

describe("BoardReactor", () => {
  it.effect("moves an in-progress card to review on executor success", () =>
    runScenario({ cards: [makeCard()] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(fixture, terminalEvent({ status: "completed" }));

        const updates = yield* Ref.get(fixture.updates);
        assert.equal(updates.length, 1);
        assert.equal(updates[0]?.status, "review");
        assert.equal(updates[0]?.outcome, "succeeded");
        assert.equal(updates[0]?.failureStreak, 0);
        assert.equal(updates[0]?.lastError, null);

        const appends = yield* Ref.get(fixture.appends);
        assert.equal(appends.length, 1);
        assert.equal(appends[0]?.status, "review");
        assert.equal(appends[0]?.body, "executor implementation finished: success");

        const commands = yield* Ref.get(fixture.commands);
        assert.equal(commands.length, 1);
        const command = commands[0];
        assert.equal(command?.type, "thread.message.system.append");
        if (command?.type === "thread.message.system.append") {
          assert.equal(command.threadId, ORCHESTRATOR_ID);
          assert.include(command.message.text, "moved to review");
        }
      }),
    ),
  );

  it.effect("records a failure without leaving in_progress and bumps the streak", () =>
    runScenario({ cards: [makeCard({ failureStreak: 1 })] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(
          fixture,
          terminalEvent({ status: "failed", terminalError: "provider exited with code 1" }),
        );

        const updates = yield* Ref.get(fixture.updates);
        assert.equal(updates.length, 1);
        assert.equal(updates[0]?.status, "in_progress");
        assert.equal(updates[0]?.outcome, "failed");
        assert.equal(updates[0]?.failureStreak, 2);
        assert.equal(updates[0]?.lastError, "provider exited with code 1");
        assert.equal(updates[0]?.executorThreadId, EXECUTOR_ID);

        const appends = yield* Ref.get(fixture.appends);
        assert.equal(appends.length, 1);
        assert.equal(appends[0]?.body, "executor implementation finished: failed");
      }),
    ),
  );

  it.effect("marks the card needs human on the third consecutive failure", () =>
    runScenario({ cards: [makeCard({ failureStreak: 2 })] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(fixture, terminalEvent({ status: "failed" }));

        const updates = yield* Ref.get(fixture.updates);
        assert.equal(updates[0]?.failureStreak, BoardReactor.NEEDS_HUMAN_FAILURE_STREAK);
        assert.equal(updates[0]?.outcome, "failed");

        const appends = yield* Ref.get(fixture.appends);
        assert.deepEqual(
          appends.map((entry) => entry.body),
          ["executor implementation finished: failed", "needs human"],
        );

        const commands = yield* Ref.get(fixture.commands);
        const command = commands[0];
        assert.equal(command?.type, "thread.message.system.append");
        if (command?.type === "thread.message.system.append") {
          assert.include(command.message.text, "needs human");
        }
      }),
    ),
  );

  it.effect("ignores a terminal event for a foreign executor thread id", () =>
    runScenario({ cards: [makeCard()] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(
          fixture,
          terminalEvent({ childThreadId: ThreadId.make("some-other-thread"), status: "completed" }),
        );

        assert.equal((yield* Ref.get(fixture.updates)).length, 0);
        assert.equal((yield* Ref.get(fixture.appends)).length, 0);
        assert.equal((yield* Ref.get(fixture.commands)).length, 0);
      }),
    ),
  );

  it.effect("ignores a terminal event when the card is not in progress", () =>
    runScenario({ cards: [makeCard({ status: "review" })] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(fixture, terminalEvent({ status: "completed" }));

        assert.equal((yield* Ref.get(fixture.updates)).length, 0);
        assert.equal((yield* Ref.get(fixture.commands)).length, 0);
      }),
    ),
  );

  it.effect("clears the dangling executor reference when its thread is deleted", () =>
    runScenario({ cards: [makeCard()] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(fixture, threadDeletedEvent(EXECUTOR_ID));

        const updates = yield* Ref.get(fixture.updates);
        assert.equal(updates.length, 1);
        assert.equal(updates[0]?.executorThreadId, null);
        assert.equal(updates[0]?.outcome, "cancelled");
        assert.equal(updates[0]?.failureStreak, 1);

        const appends = yield* Ref.get(fixture.appends);
        assert.equal(appends[0]?.body, "executor thread deleted while in progress: cancelled");
      }),
    ),
  );

  it.effect("removes the orchestrator and its cards when the orchestrator thread is deleted", () =>
    runScenario({ cards: [makeCard()] }, (fixture) =>
      Effect.gen(function* () {
        yield* handle(fixture, threadDeletedEvent(ORCHESTRATOR_ID));

        assert.equal((yield* Ref.get(fixture.orchestrators)).length, 0);
        assert.equal((yield* Ref.get(fixture.cards)).length, 0);
        assert.equal((yield* Ref.get(fixture.updates)).length, 0);
        assert.equal((yield* Ref.get(fixture.commands)).length, 0);
      }),
    ),
  );

  it.effect("recovers an in-progress card whose executor session was orphaned by a restart", () =>
    runScenario(
      {
        cards: [makeCard()],
        shells: [
          makeShell({ id: ORCHESTRATOR_ID }),
          makeShell({ id: EXECUTOR_ID, session: makeSession(EXECUTOR_ID, "error") }),
        ],
      },
      (fixture) =>
        Effect.gen(function* () {
          // `start` runs the recovery sweep inline, before the body.
          const updates = yield* Ref.get(fixture.updates);
          assert.equal(updates.length, 1);
          assert.equal(updates[0]?.status, "orchestrator");
          assert.equal(updates[0]?.outcome, "cancelled");
          assert.equal(updates[0]?.executorThreadId, null);
          assert.equal(updates[0]?.failureStreak, 1);
          assert.equal(updates[0]?.lastError, "executor session lost after restart");

          const appends = yield* Ref.get(fixture.appends);
          assert.deepEqual(
            appends.map((entry) => entry.body),
            ["executor session lost after restart: cancelled"],
          );

          const commands = yield* Ref.get(fixture.commands);
          const wake = commands.find((command) => command.type === "thread.turn.start");
          assert.isDefined(wake);
          if (wake?.type === "thread.turn.start") {
            assert.equal(wake.threadId, ORCHESTRATOR_ID);
            assert.equal(wake.message.messageId, "board:card-wake:card-1");
          }
        }),
    ),
  );

  it.effect("leaves a card with a live executor session untouched on startup", () =>
    runScenario(
      {
        cards: [makeCard()],
        shells: [makeShell({ id: EXECUTOR_ID, session: makeSession(EXECUTOR_ID, "running") })],
      },
      (fixture) =>
        Effect.gen(function* () {
          assert.equal((yield* Ref.get(fixture.updates)).length, 0);
          assert.equal((yield* Ref.get(fixture.commands)).length, 0);
        }),
    ),
  );
});
