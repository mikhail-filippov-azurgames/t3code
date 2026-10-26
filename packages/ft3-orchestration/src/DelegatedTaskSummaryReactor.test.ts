import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  idleThreadProjection,
  liveThreadShell,
} from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ServerEnvironment from "../../../apps/server/src/environment/ServerEnvironment.ts";
import * as EventSink from "../../../apps/server/src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../../apps/server/src/orchestration-v2/EventStore.ts";
import * as ProjectStore from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../../apps/server/src/persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as TextGeneration from "../../../apps/server/src/textGeneration/TextGeneration.ts";
import * as Ft3Host from "../../ft3-host/src/server.ts";
import * as Contracts from "./contracts.ts";
import * as DelegatedTaskSummaryReactor from "./DelegatedTaskSummaryReactor.ts";
import * as SummaryRepository from "./DelegatedTaskSummaryRepository.ts";
import * as TaskHandoffService from "./TaskHandoffService.ts";
import * as TaskQueryService from "./TaskQueryService.ts";

const parentId = ThreadId.make("summary:parent");
const childId = ThreadId.make("summary:child");
const epoch = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-10-26T00:01:00.000Z");
const turnId = ProviderTurnId.make("turn:child:1");
const secondTurnId = ProviderTurnId.make("turn:child:2");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
let eventOrdinal = 0;

const base = (threadId: ThreadId) => ({
  id: EventId.make(`event:${++eventOrdinal}:${threadId}`),
  threadId,
  occurredAt: now,
});

const appThread = (id: ThreadId): OrchestrationV2AppThread => ({
  ...idleThreadProjection(liveThreadShell(id, { activeRunId: null })).thread,
  modelSelection,
  worktreePath: id === childId ? "C:/work/child" : null,
  createdAt: epoch,
  updatedAt: epoch,
  lineage:
    id === childId
      ? { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" }
      : { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
});

const subagent = (): OrchestrationV2Subagent => ({
  id: NodeId.make("task:summary"),
  threadId: parentId,
  runId: null,
  parentNodeId: NodeId.make("node:parent"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: modelSelection.instanceId,
  providerThreadId: null,
  childThreadId: childId,
  nativeTaskRef: null,
  prompt: "Summarize me",
  title: "Child task",
  model: modelSelection.model,
  status: "completed",
  result: "done",
  startedAt: epoch,
  completedAt: now,
  updatedAt: now,
});

const run = (status: OrchestrationV2Run["status"] = "completed"): OrchestrationV2Run => ({
  id: RunId.make("run:child:1"),
  threadId: childId,
  ordinal: 1,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:child:user"),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: epoch,
  startedAt: epoch,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});

const attempt = (providerTurnId = turnId, attemptOrdinal = 1): OrchestrationV2RunAttempt => ({
  id: RunAttemptId.make(`attempt:${providerTurnId}`),
  runId: RunId.make("run:child:1"),
  attemptOrdinal,
  rootNodeId: NodeId.make("node:child:root"),
  providerInstanceId: modelSelection.instanceId,
  providerThreadId: ProviderThreadId.make("provider:child"),
  providerTurnId,
  reason: "initial",
  status: "completed",
  startedAt: epoch,
  completedAt: now,
});

const providerTurn = (
  status: OrchestrationV2ProviderTurn["status"],
  id = turnId,
  ordinal = 1,
): OrchestrationV2ProviderTurn => ({
  id,
  providerThreadId: ProviderThreadId.make("provider:child"),
  nodeId: NodeId.make("node:child:root"),
  runAttemptId: RunAttemptId.make(`attempt:${id}`),
  nativeTurnRef: null,
  ordinal,
  status,
  startedAt: epoch,
  completedAt: status === "running" || status === "pending" ? null : now,
});

const assistantItem = (id = turnId, ordinal = 1): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`item:${id}:assistant`),
  threadId: childId,
  runId: RunId.make("run:child:1"),
  nodeId: null,
  providerThreadId: ProviderThreadId.make("provider:child"),
  providerTurnId: id,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: epoch,
  completedAt: now,
  updatedAt: now,
  type: "assistant_message",
  messageId: MessageId.make(`message:${id}:assistant`),
  text: "Implemented the parser and ran the focused tests.",
  attachments: [],
  streaming: false,
});

const visibleItem = (
  item: OrchestrationV2TurnItem,
  position: number,
): OrchestrationV2ProjectedTurnItem => ({
  position,
  sourceThreadId: childId,
  sourceItemId: item.id,
  visibility: "local",
  item,
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
  const generations: TextGeneration.CommitMessageGenerationInput[] = [];
  const replies: Array<
    Effect.Effect<TextGeneration.CommitMessageGenerationResult, TextGenerationError>
  > = [];
  const defaultReply = () =>
    Effect.succeed({ subject: "Parser implemented", body: "- Added parser\n- Ran tests" });
  const managedThreads = Layer.unwrap(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId: ThreadId) =>
          projections.getThreadShell(threadId).pipe(Effect.orDie),
        getThreadRecords: <K extends ProjectionStore.ProjectionRecordField>(
          threadId: ThreadId,
          fields: ReadonlyArray<K>,
          filter?: ProjectionStore.ProjectionRecordFilter,
        ) => projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
      });
    }),
  );
  const textGeneration = Layer.mock(TextGeneration.TextGeneration)({
    generateCommitMessage: (input) =>
      Effect.suspend(() => {
        generations.push(input);
        return replies.shift() ?? defaultReply();
      }),
  });
  const support = Layer.mergeAll(
    textGeneration,
    ServerSettings.ServerSettingsService.layerTest(),
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:test")),
    }),
    SummaryRepository.layer,
  );
  const layer = Layer.mergeAll(
    Ft3Host.layer,
    DelegatedTaskSummaryReactor.layer.pipe(Layer.provideMerge(support)),
    TaskQueryService.layer.pipe(
      Layer.provideMerge(support),
      Layer.provideMerge(TaskHandoffService.layer),
    ),
    TaskHandoffService.layer,
  ).pipe(
    Layer.provideMerge(managedThreads),
    Layer.provideMerge(infrastructure),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  const emit = Effect.fn("test.emitSummaryEvent")(function* (event: OrchestrationV2DomainEvent) {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* sink.write({ events: [event] });
    return events[0]!;
  });
  const seed = Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    for (const id of [parentId, childId])
      yield* emit({ ...base(id), type: "thread.created", payload: appThread(id) });
    yield* emit({ ...base(parentId), type: "subagent.updated", payload: subagent() });
    yield* emit({ ...base(childId), type: "run.created", payload: run("starting") });
    yield* emit({ ...base(childId), type: "run.updated", payload: run("completed") });
    yield* emit({ ...base(childId), type: "run-attempt.created", payload: attempt() });
    yield* emit({ ...base(childId), type: "run-attempt.updated", payload: attempt() });
  });
  const completeTurn = (id = turnId, ordinal = 1) =>
    Effect.gen(function* () {
      yield* emit({ ...base(childId), type: "run-attempt.created", payload: attempt(id, ordinal) });
      yield* emit({
        ...base(childId),
        type: "turn-item.updated",
        payload: assistantItem(id, ordinal),
      });
      return yield* emit({
        ...base(childId),
        type: "provider-turn.updated",
        payload: providerTurn("completed", id, ordinal),
      });
    });
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:test"),
    requestNamespace: "session:test",
    thread: {
      threadId: parentId,
      providerSessionId: "session:test",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
  };
  return { layer, seed, emit, completeTurn, generations, replies, scope };
}

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly childThreadId: string;
    readonly sourceTurnId: string;
    readonly text: string;
    readonly source: string;
    readonly state: string;
    readonly error: string | null;
    readonly attemptCount: number;
    readonly retryAfter: string | null;
    readonly watermark: number;
  }>`SELECT child_thread_id AS "childThreadId", source_turn_id AS "sourceTurnId",
      summary_text AS text, source, state, error, attempt_count AS "attemptCount",
      retry_after AS "retryAfter", watermark
    FROM ft3_delegated_task_summaries ORDER BY source_turn_id`;
});

describe("ft3 delegated task summary reactor", () => {
  it.effect("generates one model summary when a delegated provider turn completes", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
      const event = yield* f.completeTurn();
      yield* reactor.process(event);
      const stored = yield* rows;
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.source, "model");
      assert.equal(stored[0]!.state, "ready");
      assert.equal(stored[0]!.sourceTurnId, String(turnId));
      assert.match(stored[0]!.text, /Outcome: Parser implemented/);
      assert.match(stored[0]!.text, /Added parser/);
      assert.equal(f.generations.length, 1);
      assert.match(f.generations[0]!.stagedPatch, /Implemented the parser/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("never generates twice for the same turn", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
      const event = yield* f.completeTurn();
      yield* reactor.process(event);
      yield* reactor.process(event);
      const duplicate = yield* f.emit({
        ...base(childId),
        type: "provider-turn.updated",
        payload: providerTurn("completed"),
      });
      yield* reactor.process(duplicate);
      assert.equal((yield* rows).length, 1);
      assert.equal(f.generations.length, 1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("marks a summary stale after the child starts another turn", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
      yield* reactor.process(yield* f.completeTurn());
      const service = yield* TaskQueryService.TaskQueryService;
      const current = yield* service.list(f.scope, {});
      assert.isFalse(current.tasks[0]!.summary!.stale);
      yield* f.emit({
        ...base(childId),
        type: "run-attempt.created",
        payload: attempt(secondTurnId, 2),
      });
      yield* f.emit({
        ...base(childId),
        type: "provider-turn.updated",
        payload: providerTurn("running", secondTurnId, 2),
      });
      const stale = yield* service.list(f.scope, {});
      assert.isTrue(stale.tasks[0]!.summary!.stale);
      assert.equal(stale.tasks[0]!.summary!.state, "ready");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("keeps the deterministic fallback and retries a transport failure once", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
      f.replies.push(
        Effect.fail(
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "CLI command failed",
          }),
        ),
      );
      yield* reactor.process(yield* f.completeTurn());
      const failed = yield* rows;
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.state, "pending");
      assert.equal(failed[0]!.attemptCount, 1);
      assert.equal(failed[0]!.source, "deterministic");
      assert.match(failed[0]!.text, /Summary not generated \(raw excerpt\)/);
      assert.match(failed[0]!.error ?? "", /CLI command failed/);
      assert.isNotNull(failed[0]!.retryAfter);
      yield* TestClock.adjust("11 minutes");
      yield* reactor.drain;
      const retried = yield* rows;
      assert.equal(retried[0]!.state, "ready");
      assert.equal(retried[0]!.source, "model");
      assert.equal(retried[0]!.attemptCount, 2);
      assert.equal(f.generations.length, 2);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("records a terminal error for a non-transport failure", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
      f.replies.push(
        Effect.fail(
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "invalid output",
          }),
        ),
      );
      yield* reactor.process(yield* f.completeTurn());
      const failed = yield* rows;
      assert.equal(failed[0]!.state, "error");
      assert.isNull(failed[0]!.retryAfter);
      assert.equal(f.generations.length, 1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("pages generated and imported summaries newest first", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const reactor = yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
      yield* reactor.process(yield* f.completeTurn());
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO ft3_delegated_task_summaries (
          child_thread_id, parent_environment_id, parent_thread_id, source_turn_id, completed_at,
          summary_text, source, source_turn_ids_json, watermark, content_fingerprint, state,
          error, attempt_count, retry_after, updated_at
        ) VALUES (
          ${String(childId)}, 'environment:test', ${String(parentId)}, 'legacy:turn:0',
          '2026-10-01T00:00:00.000Z', 'Historical summary', 'model', '["legacy:turn:0"]',
          0, 'legacy-fingerprint', 'ready', NULL, 1, NULL, '2026-10-01T00:00:00.000Z'
        )`;
      const service = yield* TaskQueryService.TaskQueryService;
      const page = yield* service.history(f.scope, {});
      assert.equal(page.records.length, 2);
      assert.equal(page.records[0]!.sourceTurnId, String(turnId));
      assert.equal(page.records[1]!.sourceTurnId, "legacy:turn:0");
      assert.equal(page.records[1]!.summaryText, "Historical summary");
      assert.isTrue(page.records[1]!.stale);
      const listed = yield* service.list(f.scope, {});
      assert.equal(listed.tasks[0]!.summary!.text, page.records[0]!.summaryText);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
