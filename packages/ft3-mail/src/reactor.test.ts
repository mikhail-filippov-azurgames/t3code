import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
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
import { OrchestratorCommandRejectedError } from "../../../apps/server/src/orchestration-v2/Orchestrator.ts";
import { MailRepository, MailRepositoryError, layer as mailRepositoryLayer } from "./repository.ts";
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
import type { FeatureId } from "@t3tools/ft3-policies/contracts";
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
  result: string | null = null,
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
  result,
  startedAt: epoch,
  completedAt: terminal(status) ? now : null,
  updatedAt: now,
});
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
const runOn = (threadId: ThreadId, status: "running" | "completed"): OrchestrationV2Run => ({
  id: RunId.make(`run:${String(threadId)}`),
  threadId,
  ordinal: 1,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:run:${String(threadId)}`),
  rootNodeId: NodeId.make(`node:run:${String(threadId)}`),
  activeAttemptId: null,
  status,
  requestedAt: epoch,
  startedAt: epoch,
  completedAt: status === "running" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});
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

function fixture(
  enabled = true,
  failParticipantLookup = false,
  failSteer = false,
  projectOverrides: Record<string, Partial<Record<FeatureId, boolean>>> = {},
) {
  const dispatched: Array<Dispatch> = [];
  const routing = routingFake({});
  const evidence = policyEvidenceFake();
  const launcher = launcherFake();
  // Faults are injected at the service boundary: the wrapper builds the real
  // repository and replaces exactly the methods a test drives.
  let recoverAfterDelivery: (() => Effect.Effect<void, never, never>) | null = null;
  const repositoryLayer = Layer.unwrap(
    Effect.map(
      Effect.provide(
        Effect.service(MailRepository),
        mailRepositoryLayer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
      (real) => {
        const withFaults = failParticipantLookup
          ? {
              ...real,
              findParticipantByThread: () =>
                Effect.fail(
                  new MailRepositoryError({
                    operation: "findParticipantByThread",
                    cause: new Error("forced lookup failure"),
                  }),
                ),
            }
          : real;
        return Layer.succeed(MailRepository, {
          ...withFaults,
          recordDelivery: (input) =>
            withFaults.recordDelivery(input).pipe(
              Effect.tap(() =>
                recoverAfterDelivery === null ? Effect.void : recoverAfterDelivery(),
              ),
            ),
        });
      },
    ),
  );
  const managedThreads = Layer.unwrap(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const dispatch = Effect.fn("test.dispatchMailWake")(function* (
        command: OrchestrationV2ServerCommand,
      ) {
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return yield* Effect.die("Unexpected command");
        // A run that ends after the lookup refuses the steer, like the
        // orchestrator does; the reactor must fall back to the queue.
        if (failSteer && command.dispatchMode.type === "steer_active") {
          return yield* new OrchestratorCommandRejectedError({
            commandId: command.commandId,
            commandType: command.type,
          });
        }
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
    Layer.provideMerge(repositoryLayer),
    Layer.provideMerge(gateLayer(enabled, true, projectOverrides)),
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
      members: [{ role: "implementation", specialization: "contracts" }],
    });
    return created;
  });
  return {
    layer,
    seed,
    emit,
    team,
    dispatched,
    launcher,
    setProjectFeature: (projectId: string, feature: FeatureId, value: boolean) => {
      projectOverrides[projectId] = { ...projectOverrides[projectId], [feature]: value };
    },
    setRecoverAfterDelivery: (run: (() => Effect.Effect<void, never, never>) | null) => {
      recoverAfterDelivery = run;
    },
  };
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

it.effect("writes a server answer when a turn ends with an unanswered letter", () => {
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

    // The terminal event fires after the wake was drained: the delivery the
    // server answers is delivered, not still pending.
    yield* (yield* MailDeliveryReactor).recover;
    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("completed", childId, "Partial work."),
    });
    yield* (yield* MailDeliveryReactor).process(stored);

    const repository = yield* MailRepository;
    // The member stays active; the open delivery is answered by the server.
    assert.equal((yield* repository.listMembers(created.task.taskId))[0]?.status, "active");
    assert.equal(
      (yield* repository.getDelivery(sent.deliveries[0]!.deliveryId))?.state,
      "answered",
    );
    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const answers = timeline
      .map((entry) => entry.letter)
      .filter(
        (letter) => letter.kind === "answer" && letter.senderThreadId === "mail-reactor:child",
      );
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.recipient, "lead");
    assert.equal(answers[0]?.replyToLetterId, sent.letter.letterId);
    assert.include(
      answers[0]?.body ?? "",
      "the participant's turn ended (completed) without a mail_send answer.",
    );
    assert.include(answers[0]?.body ?? "", "Partial work.");

    // The drain in the same pass wakes the lead with the server answer; the
    // participant's own wake goes out once.
    const woken = harness.dispatched.map((wake) => wake.threadId);
    assert.includeMembers(woken, [leadId, childId]);
    const leadWake = harness.dispatched.find((wake) => wake.threadId === leadId)!;
    assert.include(leadWake.text, "Partial work.");

    // A repeated terminal event writes nothing more: one letter per delivery.
    const repeated = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("completed", childId, "Partial work."),
    });
    yield* (yield* MailDeliveryReactor).process(repeated);
    const again = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    assert.equal(
      again.map((entry) => entry.letter).filter((letter) => letter.kind === "answer").length,
      1,
    );
    assert.equal(harness.dispatched.length, 2);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("names the interruption when a turn ends interrupted", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });

    yield* (yield* MailDeliveryReactor).recover;
    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("interrupted", childId, null),
    });
    yield* (yield* MailDeliveryReactor).process(stored);

    const repository = yield* MailRepository;
    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const answers = timeline
      .map((entry) => entry.letter)
      .filter((letter) => letter.kind === "answer");
    assert.equal(answers.length, 1);
    assert.include(
      answers[0]?.body ?? "",
      "the participant's turn ended (interrupted) without a mail_send answer.",
    );
    assert.include(answers[0]?.body ?? "", "(the participant left no message)");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("writes no server answer when the participant already answered", () => {
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
    yield* mail.sendLetter({
      callerThreadId: childId,
      taskId: created.task.taskId,
      to: "lead",
      kind: "answer",
      body: "Done.",
      clientRequestId: "request:answer",
      replyToLetterId: sent.letter.letterId,
    });

    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("completed", childId, "Done."),
    });
    yield* (yield* MailDeliveryReactor).process(stored);

    const repository = yield* MailRepository;
    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const answers = timeline
      .map((entry) => entry.letter)
      .filter((letter) => letter.kind === "answer");
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.body, "Done.");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps the end of a long last message in the server answer", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });

    const words = `end-${"x".repeat(2500)}`;
    yield* (yield* MailDeliveryReactor).recover;
    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("failed", childId, words),
    });
    yield* (yield* MailDeliveryReactor).process(stored);

    const repository = yield* MailRepository;
    const timeline = yield* repository.listTimeline({ taskId: created.task.taskId, limit: 10 });
    const answers = timeline
      .map((entry) => entry.letter)
      .filter((letter) => letter.kind === "answer");
    assert.equal(answers.length, 1);
    const body = answers[0]?.body ?? "";
    assert.include(body, "the participant's turn ended (failed) without a mail_send answer.");
    assert.include(body, "(showing the last 2000 of 2504 characters)");
    assert.isTrue(body.endsWith(words.slice(-2000)));
    assert.isFalse(body.includes(words.slice(0, 100)));
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
    assert.deepEqual(wake.notification?.source, { kind: "delegated_task", taskIds: [] });
    assert.include(wake.text, "Start.");
    assert.include(wake.text, 'New request letter from lead in mail task "Refactor":');
    assert.include(
      wake.text,
      `Reply with mail_send: taskId "${created.task.taskId}", to "lead", kind "answer", replyToLetterId "${sent.letter.letterId}"`,
    );
    const repository = yield* MailRepository;
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "delivered");
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("holds queued mail while its task project is off and drains it when re-enabled", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: leadId,
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:project-wake",
    });
    const reactor = yield* MailDeliveryReactor;
    const repository = yield* MailRepository;
    harness.setProjectFeature("project:mcp-test", "mail", false);

    yield* reactor.recover;
    assert.deepStrictEqual(harness.dispatched, []);
    assert.equal((yield* repository.getDelivery(sent.deliveries[0]!.deliveryId))?.state, "pending");
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 1);

    harness.setProjectFeature("project:mcp-test", "mail", true);
    yield* reactor.recover;
    assert.equal(harness.dispatched.length, 1);
    assert.equal(
      (yield* repository.getDelivery(sent.deliveries[0]!.deliveryId))?.state,
      "delivered",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("names the participant role in a wake on the lead thread", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: childId,
      taskId: created.task.taskId,
      to: "lead",
      kind: "answer",
      body: "Done.",
      clientRequestId: "request:answer",
    });
    assert.isTrue(sent.created);
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 1);
    const wake = harness.dispatched[0]!;
    assert.equal(wake.threadId, leadId);
    assert.include(
      wake.text,
      'New answer letter from implementation/contracts in mail task "Refactor":',
    );
    assert.include(wake.text, "Done.");
    assert.equal(
      wake.notification?.summary,
      'Mail answer letter from implementation/contracts in "Refactor"',
    );
    assert.deepEqual(wake.notification?.source, {
      kind: "delegated_task",
      taskIds: [],
      childThreadId: childId,
      mail: {
        taskId: created.task.taskId,
        letterId: sent.letter.letterId,
        preview: "Done.",
      },
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds the wake preview to two whole lines", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const first = yield* mail.sendLetter({
      callerThreadId: childId,
      taskId: created.task.taskId,
      to: "lead",
      kind: "answer",
      body: `Intro line.\n${"b".repeat(250)}`,
      clientRequestId: "request:long-answer",
    });
    assert.isTrue(first.created);
    yield* (yield* MailDeliveryReactor).recover;
    const second = yield* mail.sendLetter({
      callerThreadId: childId,
      taskId: created.task.taskId,
      to: "lead",
      kind: "answer",
      body: "First line.\nSecond line.\nThird line.",
      clientRequestId: "request:three-line-answer",
    });
    assert.isTrue(second.created);
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 2);
    assert.deepEqual(
      harness.dispatched.map((dispatch) => {
        const source = dispatch.notification?.source;
        return source?.kind === "delegated_task" ? source.mail : null;
      }),
      [
        {
          taskId: created.task.taskId,
          letterId: first.letter.letterId,
          preview: "Intro line.",
        },
        {
          taskId: created.task.taskId,
          letterId: second.letter.letterId,
          preview: "First line.\nSecond line.",
        },
      ],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("delivers exactly one wake when the sender lookup fails", () => {
  const harness = fixture(true, true);
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: childId,
      taskId: created.task.taskId,
      to: "lead",
      kind: "answer",
      body: "Done.",
      clientRequestId: "request:answer",
    });
    assert.isTrue(sent.created);
    // The sender lookup fails; delivery must go out anyway, without a sender
    // label and without stalling the drain.
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 1);
    const wake = harness.dispatched[0]!;
    assert.include(wake.text, 'New answer letter in mail task "Refactor":');
    assert.notInclude(wake.text, "from implementation");
    const repository = yield* MailRepository;
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "delivered");
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("marks a launched member's delivery delivered without a wake", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    // The member already got the letter in its first prompt, so there is no
    // wake to drain: one launch, one delivered delivery, no dispatch.
    assert.equal(harness.launcher.launches.length, 1);
    assert.deepStrictEqual(
      sent.deliveries.map((delivery) => delivery.state),
      ["delivered"],
    );
    const repository = yield* MailRepository;
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
    yield* (yield* MailDeliveryReactor).recover;
    assert.equal(harness.launcher.launches.length, 1);
    assert.equal(harness.dispatched.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps a launched member's delivery single when a drain runs mid-send", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const mail = yield* MailService;
    const reactor = yield* MailDeliveryReactor;
    // A drain between recording the delivery and closing the send used to see
    // the pending row already bound to the launched thread and dispatch a
    // second copy of the letter.
    harness.setRecoverAfterDelivery(() => reactor.recover.pipe(Effect.ignore));
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    harness.setRecoverAfterDelivery(null);

    assert.equal(harness.launcher.launches.length, 1);
    assert.equal(harness.dispatched.length, 0);
    const repository = yield* MailRepository;
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "delivered");
    yield* reactor.recover;
    assert.equal(harness.dispatched.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("catches up a pending delivery after restart without relaunching", () => {
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
    assert.equal(harness.launcher.launches.length, 0);
    // A crash between recording the delivery and draining its wake leaves no wake row.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM ft3_mail_wakes WHERE wake_id = ${`mail:wake:${sent.deliveries[0]!.deliveryId}`}`;
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.launcher.launches.length, 0);
    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]!.threadId, childId);
    assert.deepStrictEqual(harness.dispatched[0]!.dispatchMode, { type: "queue_after_active" });
    assert.include(harness.dispatched[0]!.text, "Start.");
    const repository = yield* MailRepository;
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "delivered");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("kills a stale wake for a delivery already answered", () => {
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
    // The member answers before the wake drains; the stale wake row must not
    // redispatch the letter.
    const repository = yield* MailRepository;
    yield* repository.markDeliveryAnswered({
      deliveryId: sent.deliveries[0]!.deliveryId,
      at: DateTime.formatIso(now),
    });
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 0);
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "answered");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("kills a stale wake for a delivery that failed", () => {
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
    const repository = yield* MailRepository;
    yield* repository.failDelivery({
      deliveryId: sent.deliveries[0]!.deliveryId,
      at: DateTime.formatIso(now),
      reason: "forced failure",
    });
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 0);
    assert.equal((yield* repository.listUndeliveredWakes({ limit: 10 })).length, 0);
    const delivery = yield* repository.getDelivery(sent.deliveries[0]!.deliveryId);
    assert.equal(delivery?.state, "failed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("steers an urgent letter into the participant's active run", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    yield* harness.emit({
      ...base(childId),
      type: "run.created",
      payload: runOn(childId, "running"),
    });
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Now.",
      clientRequestId: "request:urgent",
      urgent: true,
    });
    assert.isTrue(sent.created);
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]!.threadId, childId);
    assert.deepStrictEqual(harness.dispatched[0]!.dispatchMode, {
      type: "steer_active",
      targetRunId: runOn(childId, "running").id,
    });
    assert.include(harness.dispatched[0]!.text, "Now.");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("starts an urgent letter immediately when the participant is idle", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Now.",
      clientRequestId: "request:urgent",
      urgent: true,
    });
    yield* (yield* MailDeliveryReactor).recover;

    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]!.threadId, childId);
    assert.deepStrictEqual(harness.dispatched[0]!.dispatchMode, { type: "start_immediately" });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("queues the letter when the steer is refused", () => {
  const harness = fixture(true, false, true);
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    yield* harness.emit({
      ...base(childId),
      type: "run.created",
      payload: runOn(childId, "running"),
    });
    const mail = yield* MailService;
    yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Now.",
      clientRequestId: "request:urgent",
      urgent: true,
    });
    yield* (yield* MailDeliveryReactor).recover;

    // The refused steer never dispatches; the letter goes out behind the turn.
    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]!.threadId, childId);
    assert.deepStrictEqual(harness.dispatched[0]!.dispatchMode, { type: "queue_after_active" });
    assert.include(harness.dispatched[0]!.text, "Now.");
    // The orchestrator remembers a rejected command id forever, so the fallback needs its own.
    assert.isTrue(String(harness.dispatched[0]!.commandId).endsWith(":queued"));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("advances unrelated events without dispatching while mail is off", () => {
  const harness = fixture(false);
  return Effect.gen(function* () {
    yield* harness.seed;
    yield* (yield* MailDeliveryReactor).recover;

    const sql = yield* SqlClient.SqlClient;
    const cursor = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM ft3_mail_reactor_cursor WHERE id = 1`;
    assert.equal(cursor[0]?.sequence, 2);
    assert.equal(harness.dispatched.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("wakes the same thread after its turn ends without settling", () => {
  const harness = fixture();
  return Effect.gen(function* () {
    yield* harness.seed;
    const created = yield* harness.team;
    const member = yield* memberOf(created.task.taskId);
    yield* bindChild(member.memberId);
    const mail = yield* MailService;
    yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });

    const stored = yield* harness.emit({
      ...base(leadId),
      type: "subagent.updated",
      payload: subagent("completed", childId, "Partial work."),
    });
    yield* (yield* MailDeliveryReactor).process(stored);

    // A new letter wakes the same participant thread; the member never closed.
    const next = yield* mail.sendLetter({
      callerThreadId: ThreadId.make("mail-reactor:lead"),
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Continue.",
      clientRequestId: "request:next",
    });
    assert.isTrue(next.created);
    yield* (yield* MailDeliveryReactor).recover;

    const repository = yield* MailRepository;
    assert.equal((yield* repository.listMembers(created.task.taskId))[0]?.status, "active");
    const childWakes = harness.dispatched.filter((wake) => wake.threadId === childId);
    assert.equal(childWakes.length, 2);
    assert.include(childWakes[1]?.text ?? "", "Continue.");
    assert.deepStrictEqual(
      childWakes.map((wake) => wake.dispatchMode),
      [{ type: "queue_after_active" }, { type: "queue_after_active" }],
    );
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
