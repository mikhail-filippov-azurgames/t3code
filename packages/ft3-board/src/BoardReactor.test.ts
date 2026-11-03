import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  idleThreadProjection,
  liveThreadShell,
} from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as OrchestrationEventStore from "../../../apps/server/src/persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EventSink from "../../../apps/server/src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../../apps/server/src/orchestration-v2/EventStore.ts";
import { OrchestratorDispatchError } from "../../../apps/server/src/orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as Ft3Host from "../../ft3-host/src/server.ts";
import * as BoardReactor from "./BoardReactor.ts";
import * as Contracts from "./contracts.ts";
import {
  buildBoardWakePrompt,
  buildBoardWakeShortMessage,
  failureWords,
  shortBoardId,
} from "./boardWakePrompt.ts";

const parentId = ThreadId.make("board:parent");
const childId = ThreadId.make("board:child");
const uncardedId = ThreadId.make("board:uncarded");
const otherId = ThreadId.make("board:other");
const epoch = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-10-26T00:01:00.000Z");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
type Dispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;
let eventOrdinal = 0;
const base = (threadId: ThreadId) => ({
  id: EventId.make(`event:${++eventOrdinal}:${threadId}`),
  threadId,
  occurredAt: now,
});
const appThread = (id: ThreadId): OrchestrationV2AppThread => ({
  ...idleThreadProjection(liveThreadShell(id, { activeRunId: null })).thread,
  title: id === childId ? "Mail: address matrix" : id,
  modelSelection,
  createdAt: epoch,
  updatedAt: epoch,
  lineage:
    id === childId || id === uncardedId
      ? { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" }
      : { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
});
const run = (
  status: OrchestrationV2Run["status"],
  id = "executor:run",
  threadId = childId,
  ordinal = 1,
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: epoch,
  startedAt: epoch,
  completedAt:
    status === "running" || status === "queued" || status === "starting" || status === "waiting"
      ? null
      : now,
  checkpointId: null,
  contextHandoffId: null,
});
const provider = (
  tasks: ReadonlyArray<string> = [],
  threadId = childId,
): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`provider:${threadId}`),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: modelSelection.instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: tasks.map((taskId) => ({ kind: "command", taskId })),
  createdAt: epoch,
  updatedAt: now,
});
const subagent = (
  status: OrchestrationV2Subagent["status"] = "completed",
  childThreadId = childId,
): OrchestrationV2Subagent => ({
  id: NodeId.make("task:executor"),
  threadId: parentId,
  runId: null,
  parentNodeId: NodeId.make("node:parent"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: modelSelection.instanceId,
  providerThreadId: null,
  childThreadId,
  nativeTaskRef: null,
  prompt: "Task",
  title: "Executor",
  model: "test",
  status,
  result: null,
  startedAt: epoch,
  completedAt: status === "completed" || status === "failed" ? now : null,
  updatedAt: now,
});
const request = (
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("input:executor"),
  nodeId: NodeId.make("input:node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status,
  responseCapability: { type: "message" },
  createdAt: now,
  resolvedAt: null,
});
const card = (id = "card:one", owner = parentId): Contracts.BoardCard => ({
  cardId: Contracts.BoardCardId.make(id),
  orchestratorThreadId: owner,
  title: "Implement feature",
  body: "Acceptance criteria",
  status: "in_progress",
  readiness: "ready",
  readinessNote: null,
  createdBy: "human",
  assignee: modelSelection,
  executorRole: "implementation",
  executorThreadId: childId,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: DateTime.formatIso(epoch),
  updatedAt: DateTime.formatIso(epoch),
});

const infrastructure = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(OrchestrationEventStore.layer),
      ),
      ProjectionStore.layer,
    ),
  ),
);

function fixture() {
  const delivered: Dispatch[] = [];
  const attempts: Dispatch[] = [];
  const control = { failAfterCommit: false };
  const wakeOrdinalByCommand = new Map<string, number>();
  const managedThreads = Layer.unwrap(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const dispatch = Effect.fn("test.dispatchBoardWake")(function* (
        command: OrchestrationV2ServerCommand,
      ) {
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return yield* Effect.die("Unexpected command");
        attempts.push(command);
        const records = yield* projections
          .getThreadRecords(command.threadId, ["runs"])
          .pipe(Effect.orDie);
        const ordinal = records.runs.reduce((max, run) => Math.max(max, run.ordinal), 0) + 1;
        wakeOrdinalByCommand.set(String(command.commandId), ordinal);
        const wakeRun = run("starting", `run:${command.commandId}`, command.threadId, ordinal);
        const committed = yield* sink
          .commitCommand({
            commandId: command.commandId,
            threadId: command.threadId,
            commandType: command.type,
            acceptedAt: now,
            events: [{ ...base(command.threadId), type: "run.created", payload: wakeRun }],
            effects: [],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        if (committed.committed) delivered.push(command);
        if (control.failAfterCommit) {
          control.failAfterCommit = false;
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
          });
        }
        return { sequence: committed.receipt.resultSequence, storedEvents: committed.storedEvents };
      });
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId: ThreadId) =>
          projections.getThreadShell(threadId).pipe(Effect.orDie),
        getThreadRecords: <K extends ProjectionStore.ProjectionRecordField>(
          threadId: ThreadId,
          fields: ReadonlyArray<K>,
          filter?: ProjectionStore.ProjectionRecordFilter,
        ) => projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
        dispatch,
      });
    }),
  );
  const layer = Layer.mergeAll(Ft3Host.layer, managedThreads).pipe(
    Layer.provideMerge(infrastructure),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-ft3-board-reactor-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const emit = Effect.fn("test.emitBoardEvent")(function* (event: OrchestrationV2DomainEvent) {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* sink.write({ events: [event] });
    return events[0]!;
  });
  const seed = Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    for (const id of [parentId, childId, uncardedId, otherId])
      yield* emit({ ...base(id), type: "thread.created", payload: appThread(id) });
    const board = yield* Ft3Host.BoardRepository.BoardRepository;
    yield* board.addOrchestrator({
      threadId: parentId,
      createdBy: "human",
      createdAt: DateTime.formatIso(epoch),
    });
    yield* board.createCard(card());
  });
  const newReactor = Layer.build(BoardReactor.layer()).pipe(
    Effect.map((context) => Context.get(context, BoardReactor.BoardReactor)),
  );
  const sendRun = (
    status: OrchestrationV2Run["status"],
    id?: string,
    owner = childId,
    ordinal = 1,
  ) => emit({ ...base(owner), type: "run.updated", payload: run(status, id, owner, ordinal) });
  const sendProvider = (tasks: ReadonlyArray<string>, owner = childId) =>
    emit({ ...base(owner), type: "provider-thread.updated", payload: provider(tasks, owner) });
  const settle = Effect.fn("test.settleBoardWake")(function* () {
    const latest = delivered.at(-1)!;
    return yield* sendRun(
      "completed",
      `run:${latest.commandId}`,
      latest.threadId,
      wakeOrdinalByCommand.get(String(latest.commandId)) ?? 1,
    );
  });
  return {
    layer,
    seed,
    emit,
    newReactor,
    delivered,
    attempts,
    control,
    sendRun,
    sendProvider,
    settle,
  };
}

const pending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM ft3_board_reactor_wakes`;
});
const savedCursor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly sequence: number;
  }>`SELECT sequence FROM ft3_board_reactor_cursor`;
  return rows[0]!.sequence;
});

describe("ft3 board reactor", () => {
  it.effect.each(["completed", "failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "wakes for executor run %s and records its outcome once",
    (status) => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const reactor = yield* f.newReactor;
        const event = yield* f.sendRun(status);
        yield* reactor.process(event);
        yield* reactor.process(event);
        assert.equal(f.delivered.length, 1);
        assert.equal(f.delivered[0]!.commandId, `ft3:board:wake:${event.sequence}:${parentId}`);
        const board = yield* Ft3Host.BoardRepository.BoardRepository;
        const updated = (yield* board.getCard(card().cardId))!;
        assert.equal(updated.status, status === "completed" ? "review" : "in_progress");
        assert.equal(updated.failureStreak, status === "completed" ? 0 : 1);
        assert.equal((yield* board.listEventsForCard(updated.cardId)).length, 1);
        assert.deepStrictEqual(yield* pending, []);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect("wakes on delegated completion without counting its run twice", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendRun("failed"));
      yield* reactor.process(
        yield* f.emit({ ...base(parentId), type: "subagent.updated", payload: subagent("failed") }),
      );
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      assert.equal((yield* board.getCard(card().cardId))!.failureStreak, 1);
      assert.equal(f.delivered.length, 1);
      assert.equal((yield* pending).length, 1);
      yield* reactor.process(yield* f.settle());
      assert.equal(f.delivered.length, 2);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("wakes only for a carded executor and only once per executor", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* f.newReactor;
      const delegated = (child: ThreadId) =>
        f.emit({
          ...base(parentId),
          type: "subagent.updated",
          payload: subagent("completed", child),
        });
      yield* reactor.process(yield* f.sendRun("completed", "run:uncarded", uncardedId));
      yield* reactor.process(yield* delegated(uncardedId));
      yield* reactor.process(yield* delegated(uncardedId));
      assert.equal(f.delivered.length, 0);
      assert.deepStrictEqual(yield* pending, []);
      yield* f.sendRun("running", "parent:busy", parentId);
      yield* reactor.process(yield* f.sendRun("completed", "run:carded", childId));
      yield* reactor.process(yield* delegated(childId));
      const last = yield* delegated(childId);
      yield* reactor.process(last);
      assert.equal(f.attempts.length, 0);
      assert.equal((yield* pending).length, 1);
      yield* reactor.process(yield* f.sendRun("completed", "parent:busy", parentId));
      assert.equal(f.attempts.length, 1);
      assert.equal(f.delivered[0]!.commandId, `ft3:board:wake:${last.sequence}:${parentId}`);
      assert.include(
        f.delivered[0]!.text,
        'Executor finished "Mail: address matrix" (child): completed.',
      );
      assert.include(f.delivered[0]!.text, "Card review, ready.");
      assert.include(f.delivered[0]!.text, "card:one (Implement feature)");
      assert.notInclude(f.delivered[0]!.text, "You are the lead for this board thread.");
      assert.match(f.delivered[0]!.text, /Rules: see your lead brief\.$/);
      assert.deepStrictEqual(yield* pending, []);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("wakes with the readable card state and failure count instead of the brief", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendRun("failed", "executor:run:1", childId, 1));
      yield* reactor.process(yield* f.settle());
      yield* reactor.process(yield* f.sendRun("failed", "executor:run:2", childId, 2));
      const text = f.delivered.at(-1)!.text;
      assert.include(
        text,
        'Executor finished "Mail: address matrix" (child): failed, 2nd failure in a row. Card in_progress, ready.',
      );
      assert.include(text, "card:one (Implement feature)");
      assert.notInclude(text, "status=");
      assert.notInclude(text, "failureStreak=");
      assert.notInclude(text, "You are the lead for this board thread.");
      assert.notInclude(text, "Keep statuses truthful");
      assert.match(text, /Rules: see your lead brief\.$/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("names an executor by a readable handle when its thread id is url-encoded", () => {
    const encodedChildId = ThreadId.make(
      "thread:delegated-task:command%3Amcp%3Aaafffab1%3Adelegate-task%3Amail-address-matrix",
    );
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      yield* f.emit({
        ...base(encodedChildId),
        type: "thread.created",
        payload: appThread(encodedChildId),
      });
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      yield* board.createCard({
        ...card("card:encoded", parentId),
        title: "Address matrix",
        executorThreadId: encodedChildId,
      });
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendRun("completed", "run:encoded", encodedChildId, 1));
      const text = f.delivered.at(-1)!.text;
      assert.include(text, "Executor finished mail-add: completed.");
      assert.include(text, "Card review, ready.");
      assert.notInclude(text, "%3A");
      assert.notInclude(text, String(encodedChildId));
      assert.match(text, /Rules: see your lead brief\.$/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("wakes on a pending human-input request while its executor is waiting", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* f.newReactor;
      yield* f.sendRun("waiting");
      yield* f.emit({ ...base(parentId), type: "subagent.updated", payload: subagent("waiting") });
      const event = yield* f.emit({
        ...base(childId),
        type: "runtime-request.updated",
        payload: request(),
      });
      yield* reactor.process(event);
      assert.equal(f.delivered.length, 1);
      assert.include(f.delivered[0]!.text, "is waiting for a human answer");
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      assert.equal((yield* board.getCard(card().cardId))!.status, "in_progress");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("wakes when background work finishes, including after reactor reconstruction", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const first = yield* f.newReactor;
      yield* first.process(yield* f.sendProvider(["build", "tests"]));
      assert.equal(f.delivered.length, 0);
      const second = yield* f.newReactor;
      const finished = yield* f.sendProvider(["tests"]);
      yield* second.process(finished);
      yield* second.process(finished);
      assert.equal(f.delivered.length, 1);
      assert.include(f.delivered[0]!.text, "finished background work");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect(
    "does not wake for nonterminal work, idle rosters, resolved requests or native subagents",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const reactor = yield* f.newReactor;
        yield* reactor.process(yield* f.sendRun("running"));
        yield* reactor.process(yield* f.sendProvider([]));
        yield* reactor.process(yield* f.sendProvider([]));
        yield* reactor.process(
          yield* f.emit({
            ...base(childId),
            type: "runtime-request.updated",
            payload: request("resolved"),
          }),
        );
        yield* reactor.process(
          yield* f.emit({
            ...base(parentId),
            type: "subagent.updated",
            payload: { ...subagent(), origin: "provider_native" },
          }),
        );
        assert.equal(f.delivered.length, 0);
        assert.deepStrictEqual(yield* pending, []);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect("does not wake an unmarked thread or replay events older than the mark", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      yield* board.removeOrchestrator(parentId);
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendRun("completed"));
      assert.equal(f.delivered.length, 0);
      yield* board.addOrchestrator({
        threadId: parentId,
        createdBy: "human",
        createdAt: "2026-10-26T00:02:00.000Z",
      });
      yield* reactor.process(yield* f.sendRun("failed", "executor:old-run", childId, 2));
      assert.equal(f.delivered.length, 0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect.each(["running", "starting", "waiting", "queued", "preparing"] as const)(
    "persists a wake while the coordinator is %s and drains when it settles",
    (status) => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        yield* f.sendRun(status, "parent:busy", parentId);
        const first = yield* f.newReactor;
        const event = yield* f.sendRun("completed");
        yield* first.process(event);
        assert.equal(f.attempts.length, 0);
        assert.equal((yield* pending).length, 1);
        assert.equal(yield* savedCursor, event.sequence);
        const second = yield* f.newReactor;
        yield* second.recover;
        assert.equal(f.attempts.length, 0);
        yield* second.process(yield* f.sendRun("completed", "parent:busy", parentId));
        assert.equal(f.delivered.length, 1);
        assert.deepStrictEqual(yield* pending, []);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect("drops pending wakes when the human removes the coordinator mark", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      yield* f.sendRun("running", "parent:busy", parentId);
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendRun("failed"));
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      yield* board.removeOrchestrator(parentId);
      yield* reactor.process(yield* f.sendRun("completed", "parent:busy", parentId));
      assert.equal(f.delivered.length, 0);
      assert.deepStrictEqual(yield* pending, []);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect(
    "replays missed events from its cursor without duplicate wakes after reconstruction",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const first = yield* f.newReactor;
        const event = yield* f.sendRun("completed");
        yield* first.process(event);
        const committedCursor = yield* savedCursor;
        yield* f.settle();
        const missed = yield* f.emit({
          ...base(childId),
          type: "runtime-request.updated",
          payload: request(),
        });
        const second = yield* f.newReactor;
        yield* second.recover;
        assert.equal(f.delivered.length, 2);
        assert.isAbove(yield* savedCursor, committedCursor);
        assert.equal(yield* savedCursor, missed.sequence);
        const third = yield* f.newReactor;
        yield* third.recover;
        assert.equal(f.delivered.length, 2);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect(
    "reuses the V2 command receipt after a crash between dispatch commit and acknowledgement",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const first = yield* f.newReactor;
        f.control.failAfterCommit = true;
        const event = yield* f.sendRun("completed");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(first.process(event))));
        assert.equal(f.delivered.length, 1);
        assert.equal((yield* pending).length, 1);
        assert.equal(yield* savedCursor, event.sequence);
        yield* f.settle();
        const second = yield* f.newReactor;
        yield* second.recover;
        assert.equal(f.delivered.length, 1);
        assert.equal(f.attempts.length, 2);
        assert.equal(f.attempts[0]!.commandId, f.attempts[1]!.commandId);
        assert.deepStrictEqual(yield* pending, []);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect("escalates three failed executions once each and resets the streak on success", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* f.newReactor;
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      for (const ordinal of [1, 2, 3]) {
        const event = yield* f.sendRun("failed", `executor:run:${ordinal}`, childId, ordinal);
        yield* reactor.process(event);
        yield* reactor.process(event);
      }
      const failed = (yield* board.getCard(card().cardId))!;
      assert.equal(failed.failureStreak, 3);
      assert.equal(failed.readiness, "needs_human");
      assert.include(failed.readinessNote!, "3 executor failures");
      assert.equal((yield* board.listEventsForCard(failed.cardId)).length, 4);
      yield* reactor.process(yield* f.sendRun("completed", "executor:success", childId, 4));
      const succeeded = (yield* board.getCard(card().cardId))!;
      assert.equal(succeeded.failureStreak, 0);
      assert.equal(succeeded.status, "review");
      assert.isNull(succeeded.lastError);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("keeps a card in progress until the executor's background work finishes", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendProvider(["build"]));
      yield* reactor.process(yield* f.sendRun("completed"));
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      assert.equal((yield* board.getCard(card().cardId))!.status, "in_progress");
      yield* reactor.process(yield* f.sendProvider([]));
      yield* reactor.process(
        yield* f.emit({ ...base(parentId), type: "subagent.updated", payload: subagent() }),
      );
      assert.equal((yield* board.getCard(card().cardId))!.status, "review");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("deletes every card and its history for a shared executor with deletion proofs", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const board = yield* Ft3Host.BoardRepository.BoardRepository;
      yield* board.addOrchestrator({
        threadId: otherId,
        createdBy: "human",
        createdAt: DateTime.formatIso(epoch),
      });
      yield* board.createCard(card("card:two", otherId));
      yield* f.sendRun("running", "parent:busy", parentId);
      yield* f.sendRun("running", "other:busy", otherId);
      const reactor = yield* f.newReactor;
      yield* reactor.process(yield* f.sendRun("failed"));
      assert.equal((yield* pending).length, 2);
      const deleted = yield* f.emit({
        ...base(childId),
        type: "thread.deleted",
        payload: { ...appThread(childId), deletedAt: now },
      });
      yield* reactor.process(deleted);
      yield* reactor.process(deleted);
      assert.deepStrictEqual(yield* board.listCards(parentId), []);
      assert.deepStrictEqual(yield* board.listCards(otherId), []);
      assert.deepStrictEqual(yield* board.listEventsForCard(card().cardId), []);
      assert.equal((yield* board.listDeletionRecords()).length, 2);
      assert.equal((yield* board.listDeletionRecords())[0]!.historyEventCount, 1);
      assert.deepStrictEqual(yield* pending, []);
      assert.equal(f.delivered.length, 0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect(
    "cascades cards, history and pending wakes when an orchestrator thread is deleted",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        yield* f.sendRun("running", "parent:busy", parentId);
        const reactor = yield* f.newReactor;
        yield* reactor.process(yield* f.sendRun("failed"));
        yield* reactor.process(
          yield* f.emit({
            ...base(parentId),
            type: "thread.deleted",
            payload: { ...appThread(parentId), deletedAt: now },
          }),
        );
        const board = yield* Ft3Host.BoardRepository.BoardRepository;
        assert.deepStrictEqual(yield* board.listOrchestrators(), []);
        assert.deepStrictEqual(yield* board.listCards(parentId), []);
        assert.deepStrictEqual(yield* pending, []);
        assert.equal(f.delivered.length, 0);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect(
    "recovers an orphaned executor once after replay and preserves unknown sessions",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const first = yield* f.newReactor;
        yield* first.recover;
        const board = yield* Ft3Host.BoardRepository.BoardRepository;
        assert.equal((yield* board.getCard(card().cardId))!.status, "in_progress");
        yield* f.sendProvider([]);
        const second = yield* f.newReactor;
        yield* second.recover;
        const recovered = (yield* board.getCard(card().cardId))!;
        assert.equal(recovered.status, "orchestrator");
        assert.equal(recovered.outcome, "cancelled");
        assert.equal(recovered.failureStreak, 1);
        assert.isNull(recovered.executorThreadId);
        assert.equal(f.delivered.length, 1);
        assert.include(f.delivered[0]!.text, "lost its session when the server restarted");
        const third = yield* f.newReactor;
        yield* third.recover;
        assert.equal(f.delivered.length, 1);
        assert.equal((yield* board.listEventsForCard(card().cardId)).length, 1);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );

  it.effect("connects the worker through ft3-host and consumes live V2 events", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const sink = yield* EventSink.EventSinkV2;
      yield* Layer.build(
        Ft3Host.boardReactorLayer().pipe(
          Layer.provide(
            Layer.mock(EventSink.EventSinkV2)({
              ...sink,
              stream: (input) =>
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.drain),
                  sink.stream(input),
                ),
            }),
          ),
        ),
      );
      yield* Deferred.await(started);
      yield* f.seed;
      const event = yield* f.sendRun("completed");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const wake = yield* sink
        .stream({ afterSequence: event.sequence, eventType: "run.created" })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.equal(wake.length, 1);
      assert.equal((yield* projections.getThreadRecords(parentId, ["runs"])).runs.length, 1);
      assert.equal(f.delivered.length, 1);
      assert.include(
        f.delivered[0]!.text,
        'Executor finished "Mail: address matrix" (child): completed.',
      );
      assert.notInclude(f.delivered[0]!.text, "create-orchestrator-architect");
      assert.notInclude(f.delivered[0]!.text, "Keep statuses truthful");
      assert.match(f.delivered[0]!.text, /Rules: see your lead brief\.$/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});

it("keeps the lead brief free of the retired binding flow and names the consultants", () => {
  const brief = buildBoardWakePrompt("Card context");
  assert.include(
    brief,
    "Architects (`architect`, `architect-*`) are consultants you may call for one concrete question via `delegate_task`; for a card that needs a plan, ask the `planner` role and follow its role file.",
  );
  assert.notInclude(brief, "create-orchestrator-architect");
  assert.notInclude(brief, "get_lead_binding");
  assert.notInclude(brief, "architect_create_or_get");
  assert.notInclude(brief, "durable");
  assert.notInclude(brief, "oc://");
  assert.notInclude(brief, ".opencontext");
  assert.include(brief, "Current card context:\nCard context");
  assert.equal(buildBoardWakePrompt("Card context", "lead line").split("\n\n")[0], "lead line");
});

it("renders a short wake with readable ids and the rules pointer", () => {
  assert.equal(shortBoardId("79789b9c-1c2a-4f7e-9a3b-6d5e8f0a1b2c"), "79789b9c");
  assert.equal(shortBoardId("thread:board:child"), "child");
  assert.equal(failureWords(0), "");
  assert.equal(failureWords(1), "first failure in a row");
  assert.equal(failureWords(2), "2nd failure in a row");
  assert.equal(failureWords(11), "11th failure in a row");
  const short = buildBoardWakeShortMessage(
    'Executor finished "Mail: address matrix" (79789b9c): interrupted, 2nd failure in a row. Card in_progress, ready.',
  );
  assert.isTrue(short.endsWith("Rules: see your lead brief."));
  assert.include(short, "2nd failure in a row");
  assert.notInclude(short, "You are the lead for this board thread.");
  assert.isTrue(buildBoardWakeShortMessage("Event.").endsWith("Rules: see your lead brief."));
});
