import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  idleThreadProjection,
  liveThreadShell,
} from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as OrchestrationEventStore from "../../../apps/server/src/persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as EventSink from "../../../apps/server/src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../../apps/server/src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { MailRepository, layer as mailRepositoryLayer } from "./repository.ts";
import { MailService } from "./service.ts";
import {
  classifierFake,
  cryptoLayer,
  gateLayer,
  launcherFake,
  migrateMail,
  planGateFake,
  policyEvidenceFake,
  routingFake,
  settingsLayer,
} from "./mail.testkit.ts";
import { normalServicePolicyLayer } from "@t3tools/ft3-policies/routing";
import { layer as mailServiceLayer } from "./service.ts";
import { MailDeliveryReactor, layer as mailReactorLayer } from "./reactor.ts";

const leadId = ThreadId.make("mail-reactor:lead");
const childId = ThreadId.make("mail-reactor:child");
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
  title: id,
  modelSelection,
  createdAt: epoch,
  updatedAt: epoch,
  lineage:
    id === childId
      ? { parentThreadId: leadId, rootThreadId: leadId, relationshipToParent: "subagent" }
      : { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
});
const subagent = (
  status: OrchestrationV2Subagent["status"],
  childThreadId: ThreadId | null,
): OrchestrationV2Subagent => ({
  id: NodeId.make("task:participant"),
  threadId: leadId,
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
  title: "Participant",
  model: "test",
  status,
  result: null,
  startedAt: epoch,
  completedAt: terminal(status) ? now : null,
  updatedAt: now,
});
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
const request = (id: string, live: boolean): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make(`node:${id}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: live
    ? { type: "live", providerSessionId: ProviderSessionId.make("session:participant") }
    : { type: "message" },
  createdAt: now,
  resolvedAt: null,
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

function fixture(enabled = true) {
  const dispatched: Array<Dispatch> = [];
  const routing = routingFake({});
  const evidence = policyEvidenceFake();
  const launcher = launcherFake();
  const managedThreads = Layer.unwrap(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const dispatch = Effect.fn("test.dispatchMailWake")(function* (
        command: OrchestrationV2ServerCommand,
      ) {
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return yield* Effect.die("Unexpected command");
        dispatched.push(command);
        return { sequence: dispatched.length, storedEvents: [] };
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
  const gate = planGateFake();
  const serviceLayer = mailServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        routing.layer,
        cryptoLayer,
        evidence.layer,
        launcher.layer,
        classifierFake().layer,
        settingsLayer(),
        normalServicePolicyLayer,
        gate.layer,
      ),
    ),
  );
  const layer = mailReactorLayer.pipe(
    Layer.provideMerge(managedThreads),
    Layer.provideMerge(serviceLayer),
    Layer.provideMerge(mailRepositoryLayer),
    Layer.provideMerge(gateLayer(enabled)),
    Layer.provideMerge(infrastructure),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-ft3-mail-reactor-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const emit = Effect.fn("test.emitMailEvent")(function* (event: OrchestrationV2DomainEvent) {
    const sink = yield* EventSink.EventSinkV2;
    const stored = yield* sink.write({ events: [event] });
    return stored[0]!;
  });
  const seed = Effect.gen(function* () {
    yield* migrateMail;
    yield* emit({ ...base(leadId), type: "thread.created", payload: appThread(leadId) });
    yield* emit({ ...base(childId), type: "thread.created", payload: appThread(childId) });
  });
  const team = Effect.gen(function* () {
    const mail = yield* MailService;
    const created = yield* mail.createTask({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      clientRequestId: "request:team",
      title: "Refactor",
      brief: "Split the module.",
      level: "medium",
      members: [{ role: "implementation" }],
    });
    return created;
  });
  return { layer, seed, emit, team, dispatched, launcher };
}

const memberOf = (taskId: string) =>
  Effect.gen(function* () {
    const repository = yield* MailRepository;
    return (yield* repository.listMembers(taskId))[0]!;
  });

const bindChild = (memberId: string) =>
  Effect.gen(function* () {
    const repository = yield* MailRepository;
    yield* repository.setParticipantThread({
      memberId,
      participantThreadId: ThreadId.make("mail-reactor:child"),
      at: DateTime.formatIso(now),
    });
  });

it.effect("closes a member when its participant thread settles", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const reactor = yield* MailDeliveryReactor;

    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("completed", childId),
    });
    yield* reactor.process(stored);

    const repository = yield* MailRepository;
    assert.equal((yield* repository.listMembers(created.task.taskId))[0]?.status, "closed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("forwards a live participant question as a question letter, once", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const reactor = yield* MailDeliveryReactor;

    const stored = yield* harness.emit({
      ...base(childId),
      type: "runtime-request.updated",
      payload: request("request:one", true),
    });
    yield* reactor.process(stored);
    yield* reactor.process(stored);

    const repository = yield* MailRepository;
    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const question = timeline
      .map((entry) => entry.letter)
      .find((letter) => letter.kind === "question");
    assert.equal(question?.recipient, "lead");
    assert.include(question?.body ?? "", "request:one");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("drains a recorded wake and marks the delivery on the next tick", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    assert.isTrue(sent.created);
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 1);
    const wake = harness.dispatched[0]!;
    assert.equal(wake.threadId, childId);
    assert.deepStrictEqual(wake.dispatchMode, { type: "queue_after_active" });
    assert.include(wake.text, "Start.");
    const repository = yield* MailRepository;
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "delivered");
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("catches up a pending delivery after restart without relaunching", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    assert.equal(harness.launcher.launches.length, 1);
    const launched = ThreadId.make(`thread:participant:${member.memberId}`);
    yield* harness.emit({
      ...base(launched),
      type: "thread.created",
      payload: appThread(launched),
    });
    // A crash between recording the delivery and draining its wake leaves no wake row.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM ft3_mail_wakes WHERE wake_id = ${`mail:wake:${sent.deliveries[0]!.deliveryId}`}`;
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.launcher.launches.length, 1);
    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]!.threadId, launched);
    assert.include(harness.dispatched[0]!.text, "Start.");
    const repository = yield* MailRepository;
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "delivered");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stays quiet while mail is off", () => {
  const harness = fixture(false);
  return Effect.gen(function* () {
    yield* harness.seed;
    yield* (yield* MailDeliveryReactor).recover;

    const sql = yield* SqlClient.SqlClient;
    const cursor = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM ft3_mail_reactor_cursor WHERE id = 1`;
    assert.equal(cursor[0]?.sequence, 0);
    assert.equal(harness.dispatched.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("settles a member with stranded mail: fails deliveries and tells the lead once", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    assert.isTrue(sent.created);

    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("completed", childId),
    });
    yield* (yield* MailDeliveryReactor).process(stored);

    const repository = yield* MailRepository;
    assert.equal((yield* repository.listMembers(created.task.taskId))[0]?.status, "closed");
    const stranded = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(stranded?.state, "failed");
    assert.include(stranded?.failureReason ?? "", "implementation");

    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const notice = timeline
      .map((entry) => entry.letter)
      .find((letter) => letter.senderThreadId === "system");
    assert.equal(notice?.recipient, "lead");
    assert.equal(notice?.kind, "info");
    assert.include(notice?.body ?? "", sent.letter.letterId);
    const noticeDeliveries =
      timeline.find((entry) => entry.letter.letterId === notice?.letterId)?.deliveries ?? [];
    assert.deepStrictEqual(
      noticeDeliveries.map((delivery) => [delivery.recipient, delivery.state]),
      [["lead", "delivered"]],
    );

    // The lead got the only dispatch; the settled participant never did.
    assert.equal(harness.dispatched.length, 1);
    const wake = harness.dispatched[0]!;
    assert.equal(wake.threadId, leadId);
    assert.include(wake.text, sent.letter.letterId);

    // A second pass stays quiet: the dead wake was marked, not retried.
    yield* (yield* MailDeliveryReactor).recover;
    assert.equal(harness.dispatched.length, 1);
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("settles a member whose participant thread shell was deleted without settle", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    const repository = yield* MailRepository;
    // The thread was deleted without the settle event: no shell, no settle.
    yield* repository.setParticipantThread({
      memberId: member.memberId,
      participantThreadId: "mail-reactor:gone",
      at: DateTime.formatIso(now),
    });
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal((yield* repository.listMembers(created.task.taskId))[0]?.status, "closed");
    const failed = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(failed?.state, "failed");
    assert.include(failed?.failureReason ?? "", "was deleted");

    // The deleted participant got no dispatch; its settle recorded a lead wake,
    // and the same drain pass delivers it since the lead thread is alive.
    assert.deepStrictEqual(
      harness.dispatched.map((wake) => wake.threadId),
      [leadId],
    );
    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const notice = timeline
      .map((entry) => entry.letter)
      .find((letter) => letter.senderThreadId === "system");
    assert.include(notice?.body ?? "", "was deleted");

    // A second pass stays quiet: the dead wake was marked, not retried.
    yield* (yield* MailDeliveryReactor).recover;
    assert.equal(harness.dispatched.length, 1);
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("marks a dead wake handled without dispatching after the task closes", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const repository = yield* MailRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE ft3_mail_members SET status = 'closed' WHERE member_id = ${member.memberId}`;
    const closed = yield* repository.closeTask({
      taskId: created.task.taskId,
      outcome: "succeeded",
      summary: "Done.",
      closedAt: DateTime.formatIso(now),
    });
    assert.equal(closed?.status, "closed");
    // A wake recorded against the closed task (e.g. raced its close) is dead:
    // the query hides it, so it never dispatches again.
    yield* repository.recordWake({
      wakeId: "wake:late",
      taskId: created.task.taskId,
      targetThreadId: ThreadId.make("mail-reactor:child"),
      reason: "mail-letter",
      idempotencyKey: "mail:wake:delivery:late",
      createdAt: DateTime.formatIso(now),
    });
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);

    yield* (yield* MailDeliveryReactor).recover;
    assert.equal(harness.dispatched.length, 0);
    assert.isNull(yield* repository.getDelivery("delivery:late"));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("dispatches the next wake on the overridden model after setMemberModel", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    yield* mail.setMemberModel({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      memberId: member.memberId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-other" },
      humanInstruction: "The first model stalls.",
      clientRequestId: "request:override",
    });
    yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start again.",
      clientRequestId: "request:letter",
    });
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 1);
    assert.deepStrictEqual(harness.dispatched[0]!.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-other",
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("uses one stable wake key for the wake and pending paths", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const first = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:one",
    });
    const second = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start again.",
      clientRequestId: "request:two",
    });
    // A crash between recording the delivery and draining its wake leaves no wake row.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM ft3_mail_wakes WHERE wake_id = ${`mail:wake:${second.deliveries[0]!.deliveryId}`}`;
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 2);
    assert.deepStrictEqual(
      harness.dispatched.map((wake) => wake.commandId).toSorted(),
      [
        `mail:wake:delivery:${first.deliveries[0]!.deliveryId}`,
        `mail:wake:delivery:${second.deliveries[0]!.deliveryId}`,
      ].toSorted(),
    );
    // The message id matches the command id, so a retried dispatch dedupes.
    for (const wake of harness.dispatched) {
      assert.equal(String(wake.messageId), String(wake.commandId));
    }
  }).pipe(Effect.provide(harness.layer));
});
