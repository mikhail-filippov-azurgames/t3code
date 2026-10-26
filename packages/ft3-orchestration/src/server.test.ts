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
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import {
  idleThreadProjection,
  liveThreadShell,
} from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ProviderRegistry from "../../../apps/server/src/provider/ProviderRegistry.ts";
import { selectHistoryPageFromCursor } from "../../../apps/server/src/orchestration-v2/threadHistoryPaging.ts";
import * as Ft3Host from "../../ft3-host/src/server.ts";
import * as Contracts from "./contracts.ts";

const decodeList = Schema.decodeUnknownEffect(Contracts.TaskListResult);
const decodeSearch = Schema.decodeUnknownEffect(Contracts.TaskSearchResult);
const decodeRead = Schema.decodeUnknownEffect(Contracts.TaskReadResult);
const decodeAttach = Schema.decodeUnknownEffect(Contracts.TaskAttachHandoffResult);
const isHandoff = Schema.is(Contracts.TaskHandoff);
const isListInput = Schema.is(Contracts.TaskListInput);
const isSearchInput = Schema.is(Contracts.TaskSearchInput);
const isReadInput = Schema.is(Contracts.TaskReadInput);

const epoch = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
const handoff: Contracts.TaskHandoff = {
  contractRef: "oc://doc/319134b5-b44b-457c-a812-1dffd337f26c",
  requiredRevision: 1,
  implementsRevision: 1,
  stage: "implementation",
  owns: ["packages/ft3-orchestration/src/TaskHandoffService.ts"],
  reads: ["docs/internals/fork-boundary.md"],
  forbidden: ["apps/server/src/mcp/OrchestratorMcpService.ts"],
  acceptance: ["task_read returns the attached handoff"],
  outputs: ["handoff row"],
  evidence: ["oc://doc/319134b5-b44b-457c-a812-1dffd337f26c"],
  predecessorRefs: [],
};
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);
const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});
const parentId = ThreadId.make("thread:parent");
const otherParentId = ThreadId.make("thread:other-parent");
const aId = NodeId.make("node:a");
const bId = NodeId.make("node:b");
const foreignId = NodeId.make("node:foreign");
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
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "ft3-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ft3-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

function task(id: NodeId, owner: ThreadId, child: ThreadId): OrchestrationV2Subagent {
  return {
    id,
    threadId: owner,
    childThreadId: child,
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    nativeTaskRef: null,
    prompt: "Review parser",
    title: "Parser review",
    model: "gpt-5",
    status: "completed",
    result: "Parser checks complete",
    startedAt: epoch,
    completedAt: epoch,
    updatedAt: epoch,
  };
}

function run(id: RunId, threadId: ThreadId, ordinal = 1): OrchestrationV2Run {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: epoch,
    startedAt: epoch,
    completedAt: epoch,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function timeline(threadId: ThreadId): OrchestrationV2ProjectedTurnItem[] {
  return Array.from({ length: 3 }, (_, index) => {
    const id = TurnItemId.make(`item:${index}`);
    return {
      position: index,
      sourceThreadId: threadId,
      sourceItemId: id,
      visibility: "local",
      item: {
        id,
        threadId,
        runId: RunId.make(`run:${index}`),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index,
        status: "completed",
        title: null,
        startedAt: epoch,
        completedAt: epoch,
        updatedAt: epoch,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        messageId: MessageId.make(`message:${index}`),
        text: `Turn ${index}`,
        attachments: [],
      },
    };
  });
}

function fixture() {
  const aThreadId = ThreadId.make("thread:a");
  const bThreadId = ThreadId.make("thread:b");
  const foreignThreadId = ThreadId.make("thread:foreign");
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const projections = new Map<
    ThreadId,
    { -readonly [K in keyof OrchestrationV2ThreadProjection]: OrchestrationV2ThreadProjection[K] }
  >();
  for (const id of [parentId, otherParentId, aThreadId, bThreadId, foreignThreadId]) {
    const shell = liveThreadShell(id);
    shells.set(id, shell);
    projections.set(id, idleThreadProjection(shell));
  }
  for (const [id, parent] of [
    [aThreadId, parentId],
    [bThreadId, parentId],
    [foreignThreadId, otherParentId],
  ] as const) {
    const shell = shells.get(id)!;
    shells.set(id, {
      ...shell,
      lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent: "subagent" },
    });
  }
  shells.set(aThreadId, {
    ...shells.get(aThreadId)!,
    title: "Parser review",
    worktreePath: "C:/work/parser",
  });
  shells.set(bThreadId, { ...shells.get(bThreadId)!, title: "Archived build", archivedAt: epoch });
  projections.get(parentId)!.subagents = [
    task(bId, parentId, bThreadId),
    task(aId, parentId, aThreadId),
    { ...task(NodeId.make("node:native"), parentId, aThreadId), origin: "provider_native" },
  ];
  projections.get(otherParentId)!.subagents = [task(foreignId, otherParentId, foreignThreadId)];
  const a = projections.get(aThreadId)!;
  a.runs = [run(RunId.make("run:a"), aThreadId)];
  a.attempts = [
    {
      id: RunAttemptId.make("attempt:a"),
      runId: RunId.make("run:a"),
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node:a-root"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: ProviderThreadId.make("provider-thread:a"),
      providerTurnId: ProviderTurnId.make("turn:a"),
      reason: "initial",
      status: "completed",
      startedAt: epoch,
      completedAt: epoch,
    },
  ];
  a.providerTurns = [
    {
      id: ProviderTurnId.make("turn:a"),
      providerThreadId: ProviderThreadId.make("provider-thread:a"),
      nodeId: NodeId.make("node:a-root"),
      runAttemptId: RunAttemptId.make("attempt:a"),
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: epoch,
      completedAt: epoch,
    },
  ];
  a.visibleTurnItems = timeline(aThreadId);
  a.turnItems = a.visibleTurnItems.map((row) => row.item);
  const reads: ThreadId[] = [];
  const historyReads: string[] = [];
  const snapshots: number[] = [];
  const dependencies = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    getThreadRecords: (id) =>
      Effect.sync(() => {
        reads.push(id);
        return projections.get(id)!;
      }),
    getThreadSnapshotWindow: (id, options) =>
      Effect.sync(() => {
        snapshots.push(options.userTurnLimit ?? 0);
        return { schemaVersion: 2, snapshotSequence: 42, projection: projections.get(id)! };
      }),
    getThreadHistoryPage: (id, cursor) =>
      Effect.sync(() => {
        historyReads.push(cursor);
        return {
          snapshotSequence: 42,
          ...selectHistoryPageFromCursor({
            items: projections.get(id)!.visibleTurnItems,
            cursor,
            snapshotSequence: 42,
          }),
        };
      }),
  });
  const layer = Layer.mergeAll(...Ft3Host.mcpToolkits).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(dependencies),
    Layer.provide(providerRegistry),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(crypto),
  );
  return {
    layer,
    projections,
    shells,
    reads,
    historyReads,
    snapshots,
    aThreadId,
    bThreadId,
    foreignThreadId,
  };
}

const call = Effect.fn("test.call")(function* (
  name: string,
  args: Record<string, unknown>,
  invocation = scope,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});

function failure(result: McpSchema.CallToolResult) {
  assert.isTrue(result.isError);
  const content = result.content[0];
  assert.equal(content?.type, "text");
  if (content?.type !== "text") throw new Error("Expected a text failure.");
  return JSON.parse(content.text) as { code: string; message: string };
}

describe("ft3 task toolkit through ft3-host", () => {
  it.effect(
    "registers the read-only task tools and the handoff attachment alongside host toolkits",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const taskTools = server.tools.filter(({ tool }) => tool.name.startsWith("task_"));
        assert.deepStrictEqual(taskTools.map(({ tool }) => tool.name).sort(), [
          "task_attach_handoff",
          "task_list",
          "task_read",
          "task_search",
        ]);
        const readOnly = taskTools.filter(({ tool }) => tool.name !== "task_attach_handoff");
        assert.isTrue(readOnly.every(({ tool }) => tool.annotations?.readOnlyHint === true));
        const attach = taskTools.find(({ tool }) => tool.name === "task_attach_handoff");
        assert.isFalse(attach?.tool.annotations?.readOnlyHint);
        assert.isTrue(attach?.tool.annotations?.idempotentHint);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("attaches a parent-owned handoff and returns it from task_read and task_list", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const attached = yield* call("task_attach_handoff", { taskId: aId, handoff });
      const result = yield* decodeAttach(attached.structuredContent);
      assert.isTrue(result.created);
      assert.deepStrictEqual(result.handoff, handoff);
      const read = yield* decodeRead((yield* call("task_read", { taskId: aId })).structuredContent);
      assert.deepStrictEqual(read.handoff, handoff);
      const listed = yield* decodeList((yield* call("task_list", {})).structuredContent);
      assert.deepStrictEqual(
        listed.tasks.map((task) => task.handoff),
        [handoff, null],
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("refuses attaching to a foreign task and leaves it without a handoff", () => {
    const f = fixture();
    const other = { ...scope, thread: { ...scope.thread!, threadId: otherParentId } };
    return Effect.gen(function* () {
      const denied = yield* call("task_attach_handoff", { taskId: aId, handoff }, other);
      assert.equal(failure(denied).code, "task_not_found");
      const read = yield* decodeRead((yield* call("task_read", { taskId: aId })).structuredContent);
      assert.isNull(read.handoff);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("treats a repeated handoff as idempotent and rejects a different one", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const first = yield* decodeAttach(
        (yield* call("task_attach_handoff", { taskId: aId, handoff })).structuredContent,
      );
      const again = yield* decodeAttach(
        (yield* call("task_attach_handoff", { taskId: aId, handoff })).structuredContent,
      );
      assert.isTrue(first.created);
      assert.isFalse(again.created);
      assert.deepStrictEqual(again.handoff, handoff);
      const changed = yield* call("task_attach_handoff", {
        taskId: aId,
        handoff: { ...handoff, stage: "review" },
      });
      assert.equal(failure(changed).code, "invalid_request");
    }).pipe(Effect.provide(f.layer));
  });

  it("rejects a handoff whose revisions differ", () => {
    assert.isFalse(isHandoff({ ...handoff, implementsRevision: 2 }));
    assert.isFalse(isHandoff({ ...handoff, contractRef: "oc://doc/not-a-uuid" }));
  });

  it.effect("lists direct owned children in cursor order including archived threads", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const first = yield* call("task_list", { limit: 1 });
      const page = yield* decodeList(first.structuredContent);
      assert.deepStrictEqual(
        page.tasks.map((task) => task.taskId),
        [aId],
      );
      assert.equal(page.tasks[0]!.childThreadId, f.aThreadId);
      assert.equal(page.tasks[0]!.latestTurnId, ProviderTurnId.make("turn:a"));
      assert.isNull(page.tasks[0]!.role);
      assert.isNull(page.tasks[0]!.summary);
      assert.equal(page.nextCursor, aId);
      const second = yield* call("task_list", { afterTaskId: page.nextCursor, limit: 1 });
      const last = yield* decodeList(second.structuredContent);
      assert.deepStrictEqual(
        last.tasks.map((task) => task.taskId),
        [bId],
      );
      assert.isNull(last.nextCursor);
      assert.isFalse(f.reads.includes(f.foreignThreadId));
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("does not expose foreign, nested, deleted or mismatched children", () => {
    const f = fixture();
    f.projections.get(parentId)!.subagents = [
      ...f.projections.get(parentId)!.subagents,
      task(NodeId.make("node:forged"), parentId, f.foreignThreadId),
      task(NodeId.make("node:wrong-owner"), otherParentId, f.aThreadId),
    ];
    f.projections.get(f.aThreadId)!.subagents = [
      task(NodeId.make("node:grandchild"), f.aThreadId, f.foreignThreadId),
    ];
    f.shells.set(f.bThreadId, { ...f.shells.get(f.bThreadId)!, deletedAt: epoch });
    return Effect.gen(function* () {
      const result = yield* call("task_list", {});
      const page = yield* decodeList(result.structuredContent);
      assert.deepStrictEqual(
        page.tasks.map((task) => task.taskId),
        [aId],
      );
      assert.isFalse(f.reads.includes(f.foreignThreadId));
    }).pipe(Effect.provide(f.layer));
  });

  it.effect.each([
    ["title", "PARSER"],
    ["task id", aId],
    ["thread id", "thread:a"],
    ["turn id", "turn:a"],
    ["worktree", "C:/work/parser"],
    ["result", "checks complete"],
  ] as const)("searches by %s", ([, query]) => {
    const f = fixture();
    f.projections.get(parentId)!.subagents = f.projections
      .get(parentId)!
      .subagents.map((value) => (value.id === bId ? { ...value, result: "Build done" } : value));
    return Effect.gen(function* () {
      const result = yield* call("task_search", { query });
      const page = yield* decodeSearch(result.structuredContent);
      assert.deepStrictEqual(
        page.tasks.map((task) => task.taskId),
        [aId],
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("paginates search and finds no foreign task id", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const first = yield* call("task_search", { query: "completed", limit: 1 });
      const page = yield* decodeSearch(first.structuredContent);
      assert.equal(page.nextCursor, aId);
      const next = yield* call("task_search", { query: "completed", limit: 1, afterTaskId: aId });
      const last = yield* decodeSearch(next.structuredContent);
      assert.deepStrictEqual(
        last.tasks.map((task) => task.taskId),
        [bId],
      );
      assert.isNull(last.nextCursor);
      const foreign = yield* call("task_search", { query: foreignId });
      assert.deepStrictEqual(foreign.structuredContent, {
        query: foreignId,
        tasks: [],
        nextCursor: null,
      });
      const cursor = yield* call("task_list", { afterTaskId: foreignId });
      assert.deepStrictEqual(cursor.structuredContent, { tasks: [], nextCursor: null });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("reads older transcript pages without overlap", () => {
    const f = fixture();
    return Effect.gen(function* () {
      let beforeCursor: string | null = null;
      const texts: string[] = [];
      for (let index = 0; index < 3; index++) {
        const result = yield* call("task_read", {
          taskId: aId,
          turnLimit: 1,
          ...(beforeCursor === null ? {} : { beforeCursor }),
        });
        const page: Contracts.TaskReadResult = yield* decodeRead(result.structuredContent);
        texts.push(...page.messages.map((message) => message.text));
        assert.equal(page.page.hasMore, index < 2);
        assert.equal(page.page.threadSequence, 42);
        beforeCursor = page.page.beforeCursor;
      }
      assert.deepStrictEqual(texts, ["Turn 2", "Turn 1", "Turn 0"]);
      assert.isNull(beforeCursor);
      assert.deepStrictEqual(f.snapshots, [2]);
      assert.equal(f.historyReads.length, 2);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("serializes assistant text and V2 activities and reads archived transcripts", () => {
    const f = fixture();
    const source = timeline(f.aThreadId)[0]!.item;
    if (source.type !== "user_message") throw new Error("Expected user input.");
    const assistant = {
      ...source,
      type: "assistant_message" as const,
      id: TurnItemId.make("item:answer"),
      messageId: MessageId.make("message:answer"),
      text: "Answer",
      streaming: true,
      providerTurnId: ProviderTurnId.make("turn:a"),
    };
    const command = {
      ...source,
      type: "command_execution" as const,
      id: TurnItemId.make("item:command"),
      title: "Check parser",
      input: "check parser",
      output: "Passed",
      exitCode: 0,
    };
    const a = f.projections.get(f.aThreadId)!;
    a.visibleTurnItems = [
      timeline(f.aThreadId)[0]!,
      {
        sourceThreadId: f.aThreadId,
        sourceItemId: assistant.id,
        visibility: "local",
        position: 1,
        item: assistant,
      },
      {
        sourceThreadId: f.aThreadId,
        sourceItemId: command.id,
        visibility: "local",
        position: 2,
        item: command,
      },
    ];
    return Effect.gen(function* () {
      const result = yield* call("task_read", { taskId: aId });
      const page = yield* decodeRead(result.structuredContent);
      assert.deepStrictEqual(
        page.messages.map((message) => message.text),
        ["Turn 0", "Answer"],
      );
      assert.isTrue(page.messages[1]!.streaming);
      assert.equal(page.messages[1]!.turnId, ProviderTurnId.make("turn:a"));
      assert.equal(page.activities[0]!.kind, "command_execution");
      assert.deepInclude(page.activities[0]!.payload, {
        type: "command_execution",
        input: "check parser",
        output: "Passed",
        exitCode: 0,
        startedAt: "2026-10-25T00:00:00.000Z",
        completedAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      });
      const archived = yield* call("task_read", { taskId: bId });
      const archivedPage = yield* decodeRead(archived.structuredContent);
      assert.deepStrictEqual(archivedPage.messages, []);
      assert.isFalse(archivedPage.page.hasMore);
      assert.deepStrictEqual(f.snapshots, [9, 9]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("uses the latest child run after the original task completes", () => {
    const f = fixture();
    const a = f.projections.get(f.aThreadId)!;
    a.runs = [
      ...a.runs,
      { ...run(RunId.make("run:follow-up"), f.aThreadId, 2), status: "running" },
    ];
    return Effect.gen(function* () {
      const result = yield* call("task_list", {});
      const page = yield* decodeList(result.structuredContent);
      assert.equal(page.tasks[0]!.latestStatus, "running");
      assert.isNull(page.tasks[0]!.latestTurnId);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("reads bounded snapshots and older pages from the V2 SQLite projection", () => {
    const f = fixture();
    const persistence = ProjectionStore.layer.pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );
    const seed = Layer.effectDiscard(
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        for (const shell of f.shells.values()) {
          yield* store.apply({
            id: EventId.make(`event:${shell.id}`),
            type: "thread.created",
            threadId: shell.id,
            occurredAt: epoch,
            payload: idleThreadProjection(shell).thread,
          });
        }
        for (const id of [parentId, otherParentId]) {
          for (const subagent of f.projections.get(id)!.subagents) {
            yield* store.apply({
              id: EventId.make(`event:${subagent.id}`),
              type: "subagent.updated",
              threadId: id,
              occurredAt: epoch,
              payload: subagent,
            });
          }
        }
        for (const row of f.projections.get(f.aThreadId)!.visibleTurnItems) {
          yield* store.apply({
            id: EventId.make(`event:${row.item.id}`),
            type: "turn-item.updated",
            threadId: f.aThreadId,
            occurredAt: epoch,
            payload: row.item,
          });
        }
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE orchestration_v2_projection_subagents
          SET payload_json = json_set(payload_json, '$.handoff', json(${JSON.stringify(handoff)}))
          WHERE subagent_id = ${aId}
        `;
      }),
    );
    return Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const liveQueries = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
        getThreadRecords: (id, fields, filter) =>
          store.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
        getThreadSnapshotWindow: (id, options) =>
          store.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
        getThreadHistoryPage: (id, cursor) =>
          store.getThreadHistoryPage(id, cursor).pipe(Effect.orDie),
      });
      const layer = Layer.mergeAll(...Ft3Host.mcpToolkits).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(liveQueries),
        Layer.provide(providerRegistry),
        Layer.provide(crypto),
      );
      return yield* Effect.gen(function* () {
        const first = yield* call("task_read", { taskId: aId, turnLimit: 1 });
        const latest = yield* decodeRead(first.structuredContent);
        assert.deepStrictEqual(
          latest.messages.map((message) => message.text),
          ["Turn 2"],
        );
        assert.isTrue(latest.page.hasMore);
        const second = yield* call("task_read", {
          taskId: aId,
          turnLimit: 1,
          beforeCursor: latest.page.beforeCursor,
        });
        const older = yield* decodeRead(second.structuredContent);
        assert.deepStrictEqual(
          older.messages.map((message) => message.text),
          ["Turn 1"],
        );
        assert.deepStrictEqual(older.handoff, handoff);
        const listed = yield* decodeList((yield* call("task_list", {})).structuredContent);
        assert.deepStrictEqual(listed.tasks.find((task) => task.taskId === aId)?.handoff, handoff);
        const foreign = yield* call("task_read", { taskId: foreignId });
        assert.equal(failure(foreign).code, "task_not_found");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(seed.pipe(Layer.provideMerge(persistence))));
  });

  it.effect("refuses foreign and child-thread task ids before reading transcripts", () => {
    const f = fixture();
    return Effect.gen(function* () {
      for (const taskId of [foreignId, f.foreignThreadId, f.aThreadId, "node:unknown"]) {
        assert.equal(failure(yield* call("task_read", { taskId })).code, "task_not_found");
      }
      assert.deepStrictEqual(f.snapshots, []);
      assert.deepStrictEqual(f.historyReads, []);
      assert.deepStrictEqual(f.reads, [parentId, parentId, parentId, parentId]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("uses each request's parent instead of capturing the registration scope", () => {
    const f = fixture();
    const other = { ...scope, thread: { ...scope.thread!, threadId: otherParentId } };
    return Effect.gen(function* () {
      yield* call("task_list", {});
      const result = yield* call("task_list", {}, other);
      const page = yield* decodeList(result.structuredContent);
      assert.deepStrictEqual(
        page.tasks.map((task) => task.taskId),
        [foreignId],
      );
      assert.equal(
        failure(yield* call("task_read", { taskId: aId }, other)).code,
        "task_not_found",
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect.each([
    ["task_list", {}],
    ["task_search", { query: "parser" }],
    ["task_read", { taskId: aId }],
  ] as const)("%s refuses missing capability and threadless callers", ([name, args]) => {
    const f = fixture();
    return Effect.gen(function* () {
      assert.equal(
        failure(yield* call(name, args, { ...scope, capabilities: new Set() })).code,
        "capability_denied",
      );
      assert.equal(
        failure(yield* call(name, args, { ...scope, thread: undefined })).code,
        "thread_credential_required",
      );
      assert.deepStrictEqual(f.reads, []);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects malformed transcript cursors", () => {
    const f = fixture();
    return Effect.gen(function* () {
      assert.equal(
        failure(yield* call("task_read", { taskId: aId, beforeCursor: "not-a-cursor" })).code,
        "invalid_request",
      );
      assert.deepStrictEqual(f.historyReads, []);
    }).pipe(Effect.provide(f.layer));
  });

  it("bounds legacy input limits and query strings", () => {
    assert.isFalse(isListInput({ limit: 101 }));
    assert.isFalse(isListInput({ limit: 0 }));
    assert.isFalse(isReadInput({ taskId: aId, turnLimit: 21 }));
    assert.isFalse(isSearchInput({ query: "" }));
    assert.isFalse(isSearchInput({ query: "x".repeat(257) }));
  });
});
