import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations as runCoreMigrations } from "../../../apps/server/src/persistence/Migrations.ts";
import { runMigrations } from "../../ft3-host/src/Migrations.ts";
import { boardMailFactsLayer } from "../../ft3-mail/src/boardMailFacts.ts";
import { layer as mailRepositoryLayer } from "../../ft3-mail/src/repository.ts";
import * as BoardMailFacts from "./boardMailFacts.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as CoordinatorBoardNudgeReactor from "./CoordinatorBoardNudgeReactor.ts";
import { DEFAULT_BOARD_AUTOMATION_SETTINGS } from "./settings.ts";

const NOW = "2026-01-15T13:00:00.000Z";
const NOW_MS = Date.UTC(2026, 0, 15, 13, 0, 0);
const NOW_DATE = DateTime.makeUnsafe(NOW);
const COORDINATOR_ID = ThreadId.make("coordinator-1");

function makeSettings(
  intervalMinutes: number | null = 10,
  activeChildThreshold = 1,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ft3: {
      coordinatorBoardNudgeIntervalMinutes: intervalMinutes,
      coordinatorBoardNudgeActiveChildThreshold: activeChildThreshold,
    },
  };
}

const card = (
  cardId: string,
  overrides: Partial<Contracts.BoardCard> = {},
): Contracts.BoardCard => ({
  cardId: Contracts.BoardCardId.make(cardId),
  orchestratorThreadId: COORDINATOR_ID,
  title: `Task ${cardId}`,
  body: "Implement the task",
  status: "todo",
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
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

function shell(
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW_DATE,
    updatedAt: NOW_DATE,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

interface HarnessSeed {
  readonly cards?: ReadonlyArray<Contracts.BoardCard>;
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly history?: ReadonlyArray<Contracts.BoardCardEvent>;
}

function makeHarness(
  seed: HarnessSeed = {},
  settings = makeSettings(),
  mailFactsLayer: Layer.Layer<
    BoardMailFacts.BoardMailFacts,
    never,
    SqlClient.SqlClient
  > = boardMailFactsLayer.pipe(Layer.provide(mailRepositoryLayer)),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runCoreMigrations();
    yield* runMigrations();
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (${COORDINATOR_ID}, 'project-1', 'Coordinator', 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
    for (const thread of seed.shells ?? []) {
      yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (${thread.id}, 'project-1', ${thread.title}, 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
    }
    yield* sql`DELETE FROM ft3_board_card_events`;
    yield* sql`DELETE FROM ft3_board_cards`;
    yield* sql`DELETE FROM ft3_board_card_deletions`;
    yield* sql`INSERT OR IGNORE INTO ft3_board_orchestrators (thread_id, created_by, created_at) VALUES (${COORDINATOR_ID}, 'human', ${NOW})`;
    const repository = yield* BoardRepository.BoardRepository;
    for (const item of seed.cards ?? [card("card-1")]) yield* repository.createCard(item);
    for (const entry of seed.history ?? []) {
      const current = yield* repository.getCard(entry.cardId);
      if (current !== null) yield* repository.updateCard(current, [entry]);
    }

    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const settingsValue = yield* Ref.make(settings);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const settingsReads = yield* Ref.make(0);
    const settingsReadNotifications = yield* Queue.unbounded<number>();

    const engine = Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(
          Effect.as({ sequence: 0, storedEvents: [] }),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: seed.shells ?? [shell(COORDINATOR_ID)],
          archivedThreads: [],
        }),
    });

    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(settingsReads, (read) => read + 1);
        yield* Queue.offer(settingsReadNotifications, count);
        return yield* Ref.get(settingsValue);
      }),
      subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });

    // The reactor reads mail only through the board port; by default the
    // harness answers it with the real mail implementation over the same store.
    const reactor = yield* CoordinatorBoardNudgeReactor.make.pipe(
      Effect.provide(Layer.mergeAll(engine, settingsLayer, BoardRepository.layer, mailFactsLayer)),
    );

    return { reactor, commands, settingsReads, settingsReadNotifications, repository };
  });
}

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

function waitForSettingsReads(harness: Harness, minimum: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    let count = 0;
    while (count < minimum) count = yield* Queue.take(harness.settingsReadNotifications);
  });
}

function turnCommands(commands: ReadonlyArray<OrchestrationV2ServerCommand>) {
  return commands.filter((command) => command.type === "message.dispatch");
}

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("CoordinatorBoardNudgeReactor", (it) => {
  it.effect("does no board reads while disabled by default", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      assert.equal(DEFAULT_BOARD_AUTOMATION_SETTINGS.coordinatorBoardNudgeIntervalMinutes, null);
      const harness = yield* makeHarness({}, DEFAULT_SERVER_SETTINGS).pipe(
        Effect.provide(BoardRepository.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* harness.reactor.start();
          yield* TestClock.adjust(Duration.minutes(30));
        }),
      );
      assert.equal(yield* Ref.get(harness.settingsReads), 1);
      assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);
    }),
  );

  it.effect("nudges an idle coordinator after a full interval and records one event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const harness = yield* makeHarness({
          cards: [card("ready", { status: "orchestrator" }), card("todo-new")],
        }).pipe(Effect.provide(BoardRepository.layer));
        yield* harness.reactor.start();
        yield* TestClock.adjust(Duration.minutes(9));
        assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);

        yield* TestClock.adjust(Duration.minutes(1));
        yield* waitForSettingsReads(harness, 4);
        const commands = turnCommands(yield* Ref.get(harness.commands));
        assert.equal(commands.length, 1);
        const command = commands[0];
        assert.equal(command?.type, "message.dispatch");
        if (command?.type !== "message.dispatch") return;
        assert.equal(command.threadId, COORDINATOR_ID);
        assert.ok(command.text.includes("Card id: ready"));
        const events = yield* harness.repository.listEventsForCard(
          Contracts.BoardCardId.make("ready"),
        );
        assert.equal(events.length, 1);
      }),
    ),
  );

  it.effect("keeps a blocked coordinator quiet when the open-mail check fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const reads = yield* Ref.make(0);
      const failingMail = Layer.succeed(
        BoardMailFacts.BoardMailFacts,
        BoardMailFacts.BoardMailFacts.of({
          hasImplementLetter: () => Effect.succeed(new Set<string>()),
          hasOpenMailWork: (cardId) =>
            Ref.update(reads, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new BoardMailFacts.BoardMailFactsError({ cardId, cause: "database is locked" }),
                ),
              ),
            ),
        }),
      );
      const harness = yield* makeHarness(
        { cards: [blockedCard] },
        makeSettings(),
        failingMail,
      ).pipe(Effect.provide(BoardRepository.layer));
      yield* startAndSweep(harness);
      assert.isAbove(yield* Ref.get(reads), 0);
      assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);
    }),
  );

  it.effect("skips busy, human-waiting, deferred, and recently messaged coordinators", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const cases: ReadonlyArray<Partial<OrchestrationV2ThreadShell>> = [
        { status: "running" },
        {
          pendingRuntimeRequest: {
            id: "request-1" as never,
            kind: "user_input",
            createdAt: NOW_DATE,
          },
        },
        { snoozedUntil: DateTime.makeUnsafe("2026-01-15T13:20:00.000Z") },
        { latestUserMessageAt: DateTime.makeUnsafe("2026-01-15T13:05:00.000Z") },
      ];
      for (const overrides of cases) {
        yield* TestClock.setTime(NOW_MS);
        const harness = yield* makeHarness({ shells: [shell(COORDINATOR_ID, overrides)] }).pipe(
          Effect.provide(BoardRepository.layer),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* harness.reactor.start();
            yield* TestClock.adjust(Duration.minutes(10));
            yield* waitForSettingsReads(harness, 3);
          }),
        );
        assert.equal(
          turnCommands(yield* Ref.get(harness.commands)).length,
          0,
          JSON.stringify(overrides),
        );
      }
    }),
  );

  const blockedCard = card("blocked-1", {
    status: "orchestrator",
    readiness: "blocked",
    readinessNote: "Waiting for the participant.",
  });

  const clearMail = (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM ft3_mail_deliveries`;
      yield* sql`DELETE FROM ft3_mail_kind_feedback`;
      yield* sql`DELETE FROM ft3_mail_letters`;
      yield* sql`DELETE FROM ft3_mail_rounds`;
      yield* sql`DELETE FROM ft3_mail_wakes`;
      yield* sql`DELETE FROM ft3_mail_members`;
      yield* sql`DELETE FROM ft3_mail_tasks`;
    });

  const seedMailTask = (sql: SqlClient.SqlClient, taskId: string, requestId: string) =>
    sql`INSERT INTO ft3_mail_tasks (
        task_id, title, brief, level, card_id, response_budget_seconds, status,
        created_by_thread_id, client_request_id, request_fingerprint, created_at, updated_at
      ) VALUES (
        ${taskId}, 'Mail task', 'Brief', 'medium', 'blocked-1', 1800, 'open',
        ${COORDINATOR_ID}, ${requestId}, 'fingerprint', ${NOW}, ${NOW}
      )`;

  const startAndSweep = (harness: Harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* harness.reactor.start();
        yield* TestClock.adjust(Duration.minutes(10));
        yield* waitForSettingsReads(harness, 3);
      }),
    );

  it.effect("skips a blocked card while a mail round is open", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* makeHarness({ cards: [blockedCard] }).pipe(
        Effect.provide(BoardRepository.layer),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* clearMail(sql);
      yield* seedMailTask(sql, "task-round", "request-round");
      yield* sql`INSERT INTO ft3_mail_rounds (round_id, task_id, round_number, kind, opened_at)
        VALUES ('round-open', 'task-round', 1, 'request', ${NOW})`;
      yield* startAndSweep(harness);
      assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);
    }),
  );

  it.effect("skips a blocked card while a mail delivery is undelivered or unanswered", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly taskId: string;
        readonly deliveryId: string;
        readonly deliveredAt: string | null;
        readonly state: string;
      }> = [
        {
          taskId: "task-undelivered",
          deliveryId: "delivery-undelivered",
          deliveredAt: null,
          state: "pending",
        },
        {
          taskId: "task-unanswered",
          deliveryId: "delivery-unanswered",
          deliveredAt: NOW,
          state: "read",
        },
      ];
      for (const item of cases) {
        yield* TestClock.setTime(NOW_MS);
        const harness = yield* makeHarness({ cards: [blockedCard] }).pipe(
          Effect.provide(BoardRepository.layer),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* clearMail(sql);
        yield* seedMailTask(sql, item.taskId, `request-${item.taskId}`);
        yield* sql`INSERT INTO ft3_mail_letters (
            letter_id, task_id, sequence, sender_thread_id, recipient, kind, body,
            client_request_id, request_fingerprint, created_at
          ) VALUES (
            ${`letter-${item.taskId}`}, ${item.taskId}, 1, ${COORDINATOR_ID}, 'member-1', 'request', 'Body',
            ${`letter-request-${item.taskId}`}, 'fingerprint', ${NOW}
          )`;
        yield* sql`INSERT INTO ft3_mail_deliveries (
            delivery_id, task_id, letter_id, recipient, state, delivered_at, created_at, updated_at
          ) VALUES (
            ${item.deliveryId}, ${item.taskId}, ${`letter-${item.taskId}`}, 'member-1', ${item.state},
            ${item.deliveredAt}, ${NOW}, ${NOW}
          )`;
        yield* startAndSweep(harness);
        assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0, item.deliveryId);
      }
    }),
  );

  it.effect("nudges a blocked card once its mail settled, failed, or closed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* makeHarness({ cards: [blockedCard] }).pipe(
        Effect.provide(BoardRepository.layer),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* clearMail(sql);
      yield* seedMailTask(sql, "task-settled", "request-settled");
      yield* sql`INSERT INTO ft3_mail_rounds (round_id, task_id, round_number, kind, opened_at, closed_at)
        VALUES ('round-settled', 'task-settled', 1, 'request', ${NOW}, ${NOW})`;
      yield* sql`INSERT INTO ft3_mail_letters (
          letter_id, task_id, sequence, sender_thread_id, recipient, kind, body,
          client_request_id, request_fingerprint, created_at
        ) VALUES (
          'letter-settled', 'task-settled', 1, ${COORDINATOR_ID}, 'member-1', 'request', 'Body',
          'letter-request-settled', 'fingerprint', ${NOW}
        )`;
      yield* sql`INSERT INTO ft3_mail_deliveries (
          delivery_id, task_id, letter_id, recipient, state, delivered_at, read_at, answered_at, created_at, updated_at
        ) VALUES (
          'delivery-settled', 'task-settled', 'letter-settled', 'member-1', 'answered', ${NOW}, ${NOW}, ${NOW}, ${NOW}, ${NOW}
        )`;
      yield* seedMailTask(sql, "task-failed", "request-failed");
      yield* sql`INSERT INTO ft3_mail_letters (
          letter_id, task_id, sequence, sender_thread_id, recipient, kind, body,
          client_request_id, request_fingerprint, created_at
        ) VALUES (
          'letter-failed', 'task-failed', 1, ${COORDINATOR_ID}, 'member-1', 'request', 'Body',
          'letter-request-failed', 'fingerprint', ${NOW}
        )`;
      yield* sql`INSERT INTO ft3_mail_deliveries (
          delivery_id, task_id, letter_id, recipient, state, delivered_at, created_at, updated_at
        ) VALUES (
          'delivery-failed', 'task-failed', 'letter-failed', 'member-1', 'failed', ${NOW}, ${NOW}, ${NOW}
        )`;
      yield* sql`UPDATE ft3_mail_tasks SET status = 'closed' WHERE task_id = 'task-failed'`;
      yield* startAndSweep(harness);
      const commands = turnCommands(yield* Ref.get(harness.commands));
      assert.equal(commands.length, 1);
      const command = commands[0];
      if (command?.type !== "message.dispatch") return;
      assert.ok(command.text.includes("Card id: blocked-1"));
    }),
  );

  it.effect("waits for live child work and treats the active-child threshold as busy", () =>
    Effect.gen(function* () {
      const child = shell(ThreadId.make("child-1"), {
        status: "running",
        lineage: {
          parentThreadId: COORDINATOR_ID,
          relationshipToParent: "subagent",
          rootThreadId: COORDINATOR_ID,
        },
      });
      const harness = yield* makeHarness({
        shells: [shell(COORDINATOR_ID), child],
      }).pipe(Effect.provide(BoardRepository.layer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* harness.reactor.start();
          yield* TestClock.adjust(Duration.minutes(10));
          yield* waitForSettingsReads(harness, 3);
        }),
      );
      assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 0);
    }),
  );

  it.effect("sends one attempt per card version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cards: [card("versioned", { status: "review" })] }).pipe(
        Effect.provide(BoardRepository.layer),
      );
      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* harness.reactor.start();
          yield* TestClock.adjust(Duration.minutes(10));
          yield* waitForSettingsReads(harness, 4);
          return yield* harness.repository.listEventsForCard(
            Contracts.BoardCardId.make("versioned"),
          );
        }),
      );
      assert.equal(turnCommands(yield* Ref.get(harness.commands)).length, 1);
      assert.equal(history.length, 1);

      const replay = yield* makeHarness({
        cards: [card("versioned", { status: "review" })],
        history,
      }).pipe(Effect.provide(BoardRepository.layer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* replay.reactor.start();
          yield* TestClock.adjust(Duration.minutes(10));
          yield* waitForSettingsReads(replay, 3);
        }),
      );
      assert.equal(turnCommands(yield* Ref.get(replay.commands)).length, 0);
    }),
  );

  it("keys an attempt by coordinator, card, status, and card version", () => {
    const original = card("versioned");
    const first = CoordinatorBoardNudgeReactor.coordinatorBoardNudgeAttemptId(
      COORDINATOR_ID,
      original,
    );
    assert.equal(first, `board:idle-nudge:${COORDINATOR_ID}:versioned:todo:${NOW}`);
    assert.notEqual(
      CoordinatorBoardNudgeReactor.coordinatorBoardNudgeAttemptId(
        COORDINATOR_ID,
        card("versioned", { updatedAt: "2026-01-15T13:01:00.000Z" }),
      ),
      first,
    );
  });

  it("formats ready-state guidance and sanitizes the last error", () => {
    const text = CoordinatorBoardNudgeReactor.formatCoordinatorBoardNudgeMessage(
      card("review-card", { status: "review", lastError: "provider failed" }),
      0,
      1,
    );
    assert.ok(text.includes("automatic board check, not a message from a person"));
    assert.ok(text.includes("Last error: provider failed"));
    assert.ok(text.includes("Rules: see your lead brief"));
    const secret = `ghp_${"A".repeat(32)}`;
    const blocked = CoordinatorBoardNudgeReactor.formatCoordinatorBoardNudgeMessage(
      card("blocked-card", {
        readiness: "blocked",
        readinessNote: `Waiting for review ${secret}`,
      }),
      0,
      1,
    );
    assert.ok(blocked.includes("This card is blocked and no other card can move:"));
    assert.ok(!blocked.includes(secret));
  });
});

describe("CoordinatorBoardNudgeReactor config", () => {
  it("defaults off", () => {
    assert.equal(DEFAULT_BOARD_AUTOMATION_SETTINGS.coordinatorBoardNudgeIntervalMinutes, null);
  });
});
