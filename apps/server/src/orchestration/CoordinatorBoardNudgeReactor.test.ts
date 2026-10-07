import {
  BoardCardId,
  DEFAULT_SERVER_SETTINGS,
  type BoardCard,
  type BoardCardEvent,
  type BoardOrchestrator,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { BoardRepository } from "../persistence/Services/Board.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CoordinatorBoardNudgeReactor from "./CoordinatorBoardNudgeReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-01-15T13:00:00.000Z";
const NOW_MS = Date.UTC(2026, 0, 15, 13, 0, 0);
const COORDINATOR_ID = ThreadId.make("coordinator-1");

function makeSettings(
  intervalMinutes: number | null = 10,
  activeChildThreshold = 1,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    coordinatorBoardNudgeIntervalMinutes: intervalMinutes,
    coordinatorBoardNudgeActiveChildThreshold: activeChildThreshold,
  };
}

function makeCard(cardId: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    cardId: BoardCardId.make(cardId),
    orchestratorThreadId: COORDINATOR_ID,
    title: `Task ${cardId}`,
    body: "Implement the task",
    status: "todo",
    createdBy: "orchestrator",
    assignee: null,
    executorRole: "implementation",
    executorThreadId: null,
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
  activeTurnId: TurnId | null = null,
): OrchestrationSession {
  return {
    threadId,
    status,
    providerName: "codex",
    activeTurnId,
    runtimeMode: "full-access",
    lastError: null,
    updatedAt: NOW,
  };
}

function makeShell(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
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

function makeCoordinator(threadId = COORDINATOR_ID): BoardOrchestrator {
  return { threadId, createdBy: "human", createdAt: NOW };
}

interface HarnessSeed {
  readonly orchestrators?: ReadonlyArray<BoardOrchestrator>;
  readonly cards?: ReadonlyArray<BoardCard>;
  readonly shells?: ReadonlyArray<OrchestrationThreadShell>;
  readonly history?: ReadonlyArray<BoardCardEvent>;
}

function makeHarness(seed: HarnessSeed = {}, settings = makeSettings()) {
  return Effect.gen(function* () {
    const orchestrators = yield* Ref.make(seed.orchestrators ?? [makeCoordinator()]);
    const cards = yield* Ref.make(seed.cards ?? [makeCard("card-1")]);
    const shells = yield* Ref.make(seed.shells ?? [makeShell(COORDINATOR_ID)]);
    const history = yield* Ref.make(seed.history ?? []);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const settingsValue = yield* Ref.make(settings);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const boardReads = yield* Ref.make(0);
    const snapshotReads = yield* Ref.make(0);
    const settingsReads = yield* Ref.make(0);
    const settingsReadNotifications = yield* Queue.unbounded<number>();

    const board = Layer.mock(BoardRepository)({
      listOrchestrators: () =>
        Ref.update(boardReads, (count) => count + 1).pipe(Effect.andThen(Ref.get(orchestrators))),
      listCards: () =>
        Ref.update(boardReads, (count) => count + 1).pipe(Effect.andThen(Ref.get(cards))),
      getCard: (cardId) =>
        Ref.update(boardReads, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(cards)),
          Effect.map((all) => Option.fromNullishOr(all.find((card) => card.cardId === cardId))),
        ),
      listEventsForCard: ({ cardId }) =>
        Ref.update(boardReads, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(history)),
          Effect.map((all) => all.filter((event) => event.cardId === cardId)),
        ),
      appendEvent: (event) => Ref.update(history, (all) => [...all, event]),
    });

    const engine = Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
    });

    const snapshot = Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Ref.update(snapshotReads, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(shells)),
          Effect.map((threads) => ({
            snapshotSequence: 1,
            projects: [],
            threads,
            updatedAt: NOW,
          })),
        ),
    });

    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Effect.gen(function* () {
        yield* Ref.update(settingsReads, (count) => count + 1);
        const count = yield* Ref.get(settingsReads);
        yield* Queue.offer(settingsReadNotifications, count);
        return yield* Ref.get(settingsValue);
      }),
      streamChanges: Stream.fromPubSub(settingsChanges),
      subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });

    const dependencies = Layer.mergeAll(board, engine, snapshot, settingsLayer);
    const reactor = yield* CoordinatorBoardNudgeReactor.make.pipe(Effect.provide(dependencies));

    return {
      reactor,
      commands,
      history,
      boardReads,
      snapshotReads,
      settingsReads,
      settingsReadNotifications,
    };
  });
}

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

interface RunResult {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly history: ReadonlyArray<BoardCardEvent>;
  readonly boardReads: number;
  readonly snapshotReads: number;
  readonly settingsReads: number;
}

function runFirstSweep(
  seed: HarnessSeed = {},
  settings = makeSettings(),
  expectedHistoryWrites = 0,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* makeHarness(seed, settings);
      yield* harness.reactor.start();
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.minutes(10));
      yield* waitForSettingsReads(harness, 3 + expectedHistoryWrites);
      return yield* readHarness(harness);
    }),
  );
}

function waitForSettingsReads(harness: Harness, minimum: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    let count = 0;
    while (count < minimum) {
      count = yield* Queue.take(harness.settingsReadNotifications);
    }
  });
}

function readHarness(harness: Harness): Effect.Effect<RunResult> {
  return Effect.gen(function* () {
    return {
      commands: yield* Ref.get(harness.commands),
      history: yield* Ref.get(harness.history),
      boardReads: yield* Ref.get(harness.boardReads),
      snapshotReads: yield* Ref.get(harness.snapshotReads),
      settingsReads: yield* Ref.get(harness.settingsReads),
    };
  });
}

function turnCommands(commands: ReadonlyArray<OrchestrationCommand>) {
  return commands.filter((command) => command.type === "thread.turn.start");
}

describe("CoordinatorBoardNudgeReactor", () => {
  it.effect("does no board or thread reads while disabled by default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        assert.equal(DEFAULT_SERVER_SETTINGS.coordinatorBoardNudgeIntervalMinutes, null);
        const harness = yield* makeHarness({}, DEFAULT_SERVER_SETTINGS);
        yield* harness.reactor.start();
        yield* TestClock.adjust(Duration.minutes(30));
        yield* Effect.yieldNow;

        assert.equal(yield* Ref.get(harness.settingsReads), 1);
        assert.equal(yield* Ref.get(harness.boardReads), 0);
        assert.equal(yield* Ref.get(harness.snapshotReads), 0);
        assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);
      }),
    ),
  );

  it.effect(
    "waits a full interval, counts only live session work, and prefers the orchestrator card",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const childWithBackgroundWork = makeShell(ThreadId.make("child-live"), {
            session: makeSession(ThreadId.make("child-live"), "ready"),
            backgroundLiveness: "working",
            delegationParent: {
              parentThreadId: COORDINATOR_ID,
              parentEnvironmentId: "environment-1",
              role: "implementation",
            },
          });
          const staleChildSignals = makeShell(ThreadId.make("child-stale"), {
            session: makeSession(ThreadId.make("child-stale"), "ready"),
            hasPendingApprovals: true,
            hasPendingUserInput: true,
            latestTurn: {
              turnId: TurnId.make("stale-turn"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            delegationParent: {
              parentThreadId: COORDINATOR_ID,
              parentEnvironmentId: "environment-1",
              role: "implementation",
            },
          });
          const harness = yield* makeHarness(
            {
              cards: [
                makeCard("todo-new", { createdAt: "2026-01-15T12:03:00.000Z" }),
                makeCard("review-old", {
                  status: "review",
                  createdAt: "2026-01-15T11:00:00.000Z",
                }),
                makeCard("todo-old", {
                  title: "Oldest Plan task",
                  createdAt: "2026-01-15T12:01:00.000Z",
                }),
                makeCard("ready", {
                  status: "orchestrator",
                  createdAt: "2026-01-15T10:00:00.000Z",
                }),
              ],
              shells: [makeShell(COORDINATOR_ID), childWithBackgroundWork, staleChildSignals],
            },
            makeSettings(10, 2),
          );

          yield* harness.reactor.start();
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.minutes(9));
          assert.equal(yield* Ref.get(harness.snapshotReads), 0);
          assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);

          yield* TestClock.adjust(Duration.minutes(1));
          yield* waitForSettingsReads(harness, 4);
          const result = yield* readHarness(harness);
          assert.equal(result.snapshotReads, 1);
          const turns = turnCommands(result.commands);
          assert.equal(turns.length, 1);
          assert.equal(turns[0]?.type, "thread.turn.start");
          if (turns[0]?.type !== "thread.turn.start") return;
          assert.equal(turns[0].threadId, COORDINATOR_ID);
          assert.equal(turns[0].runOrigin._tag, "board-idle-nudge");
          assert.ok(turns[0].message.text.includes("Task ready"));
          assert.ok(turns[0].message.text.includes("Card id: ready"));
          assert.ok(turns[0].message.text.includes("1 active child task(s)"));
          assert.ok(turns[0].message.text.includes("threshold is 2"));
          assert.equal(result.history.length, 1);
          assert.equal(result.history[0]?.cardId, BoardCardId.make("ready"));
        }),
      ),
  );

  it.effect("orders candidates orchestrator, then review, then todo", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly cards: ReadonlyArray<BoardCard>;
        readonly expected: string;
      }> = [
        {
          cards: [
            makeCard("todo-card", { createdAt: "2026-01-15T09:00:00.000Z" }),
            makeCard("review-card", {
              status: "review",
              createdAt: "2026-01-15T10:00:00.000Z",
            }),
            makeCard("orchestrator-card", {
              status: "orchestrator",
              createdAt: "2026-01-15T11:00:00.000Z",
            }),
          ],
          expected: "orchestrator-card",
        },
        {
          cards: [
            makeCard("todo-card", { createdAt: "2026-01-15T09:00:00.000Z" }),
            makeCard("review-card", {
              status: "review",
              createdAt: "2026-01-15T10:00:00.000Z",
            }),
          ],
          expected: "review-card",
        },
        { cards: [makeCard("todo-card")], expected: "todo-card" },
        {
          cards: [
            makeCard("orchestrator-new", {
              status: "orchestrator",
              createdAt: "2026-01-15T11:00:00.000Z",
            }),
            makeCard("orchestrator-old", {
              status: "orchestrator",
              createdAt: "2026-01-15T08:00:00.000Z",
            }),
          ],
          expected: "orchestrator-old",
        },
      ];

      for (const { cards, expected } of cases) {
        const result = yield* runFirstSweep({ cards }, makeSettings(), 1);
        const turns = turnCommands(result.commands);
        assert.equal(turns.length, 1);
        assert.equal(turns[0]?.type, "thread.turn.start");
        if (turns[0]?.type !== "thread.turn.start") continue;
        assert.ok(
          turns[0].message.text.includes(`Card id: ${expected}`),
          `expected ${expected}, got: ${turns[0].message.text}`,
        );
      }
    }),
  );

  it.effect("does not nudge at or above the active-child threshold", () =>
    Effect.gen(function* () {
      for (const [threshold, activeChildren] of [
        [1, 1],
        [2, 2],
      ] as const) {
        const children = Array.from({ length: activeChildren }, (_, index) => {
          const childId = ThreadId.make(`child-${threshold}-${index}`);
          return makeShell(childId, {
            session: makeSession(childId, "running"),
            delegationParent: {
              parentThreadId: COORDINATOR_ID,
              parentEnvironmentId: "environment-1",
              role: "implementation",
            },
          });
        });
        const result = yield* runFirstSweep(
          { shells: [makeShell(COORDINATOR_ID), ...children] },
          makeSettings(10, threshold),
        );
        assert.equal(turnCommands(result.commands).length, 0);
      }
    }),
  );

  it.effect("skips backlog, archived, in-progress, done, and failure-capped cards", () =>
    Effect.gen(function* () {
      const result = yield* runFirstSweep({
        cards: [
          makeCard("backlog", { status: "backlog" }),
          makeCard("working", { status: "in_progress" }),
          makeCard("done", { status: "done" }),
          makeCard("archived", { archived: true }),
          makeCard("failed-three-times", { failureStreak: 3 }),
        ],
      });
      assert.equal(turnCommands(result.commands).length, 0);
      assert.equal(result.snapshotReads, 0);
    }),
  );

  it.effect("skips a busy, human-waiting, deferred, or recently messaged coordinator", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Partial<OrchestrationThreadShell>> = [
        { session: makeSession(COORDINATOR_ID, "running") },
        { hasPendingApprovals: true },
        { hasPendingUserInput: true },
        { snoozedUntil: "2026-01-15T13:20:00.000Z" },
        { latestUserMessageAt: "2026-01-15T13:05:00.000Z" },
      ];
      for (const overrides of cases) {
        const result = yield* runFirstSweep({ shells: [makeShell(COORDINATOR_ID, overrides)] });
        assert.equal(turnCommands(result.commands).length, 0);
      }
    }),
  );

  it.effect("persists one attempt per card version and allows three coordinators per sweep", () =>
    Effect.gen(function* () {
      const first = yield* runFirstSweep({}, makeSettings(), 1);
      assert.equal(turnCommands(first.commands).length, 1);

      const replay = yield* runFirstSweep(
        {
          history: first.history,
        },
        makeSettings(10, 1),
      );
      assert.equal(turnCommands(replay.commands).length, 0);

      const ids = [1, 2, 3, 4].map((index) => ThreadId.make(`coordinator-${index}`));
      const orchestrators = ids.map((threadId) => makeCoordinator(threadId));
      const shells = ids.map((threadId) => makeShell(threadId));
      const cards = [
        makeCard("first-a", { orchestratorThreadId: ids[0]! }),
        makeCard("first-b", { orchestratorThreadId: ids[0]! }),
        makeCard("second", { orchestratorThreadId: ids[1]! }),
        makeCard("third", { orchestratorThreadId: ids[2]! }),
        makeCard("fourth", { orchestratorThreadId: ids[3]! }),
      ];
      const limited = yield* runFirstSweep(
        { orchestrators, shells, cards },
        makeSettings(10, 1),
        3,
      );
      const turns = turnCommands(limited.commands).filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      );
      assert.equal(turns.length, 3);
      assert.equal(new Set(turns.map((command) => command.threadId)).size, 3);
      assert.equal(turns.filter((command) => command.threadId === ids[0]).length, 1);
    }),
  );

  it("keys an attempt by coordinator, card, status, and card version", () => {
    const original = makeCard("versioned");
    const first = CoordinatorBoardNudgeReactor.coordinatorBoardNudgeAttemptId(
      COORDINATOR_ID,
      original,
    );
    assert.equal(first, `board:idle-nudge:${COORDINATOR_ID}:versioned:todo:${NOW}`);
    assert.notEqual(
      CoordinatorBoardNudgeReactor.coordinatorBoardNudgeAttemptId(
        COORDINATOR_ID,
        makeCard("versioned", { updatedAt: "2026-01-15T13:01:00.000Z" }),
      ),
      first,
    );
    assert.notEqual(
      CoordinatorBoardNudgeReactor.coordinatorBoardNudgeAttemptId(
        COORDINATOR_ID,
        makeCard("versioned", { status: "review" }),
      ),
      first,
    );
  });

  it("formats state guidance, the automatic source, and a sanitized last error", () => {
    const card = makeCard("review-card", {
      title: "Review the patch",
      status: "review",
      lastError: "provider failed",
    });
    const text = CoordinatorBoardNudgeReactor.formatCoordinatorBoardNudgeMessage(card, 0, 1);
    assert.ok(text.includes("automatic board check, not a message from a person"));
    assert.ok(text.includes("Review the work"));
    assert.ok(text.includes("Last error: provider failed"));
    assert.ok(text.includes("move it to Backlog"));

    assert.ok(
      CoordinatorBoardNudgeReactor.formatCoordinatorBoardNudgeMessage(
        makeCard("plan-card", { status: "todo" }),
        0,
        1,
      ).includes("delegate it to an executor"),
    );
    assert.ok(
      CoordinatorBoardNudgeReactor.formatCoordinatorBoardNudgeMessage(
        makeCard("ready-card", { status: "orchestrator" }),
        0,
        1,
      ).includes("move it to Plan (todo)"),
    );
  });
});
