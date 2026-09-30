// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderItemId,
  RuntimeRequestId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  ProviderRuntimeIngestionLive,
  splitBufferedAssistantText,
} from "./ProviderRuntimeIngestion.ts";
import { BOARD_ORCHESTRATOR_TURN_TEXT } from "../boardWakePrompt.ts";
import { DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const delegatedChildTurnKey = (childThreadId: ThreadId, turnId: TurnId): string =>
  `${String(childThreadId).length}:${childThreadId}${String(turnId).length}:${turnId}`;
const delegationWakeMessageId = (childThreadId: ThreadId, turnId: TurnId): MessageId =>
  asMessageId(`delegation-wake:${delegatedChildTurnKey(childThreadId, turnId)}`);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(
    PubSub.unbounded<{
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
      readonly enqueued?: Deferred.Deferred<void>;
    }>(),
  );
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    assertConversationRollbackSupported: () => unsupported(),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub).pipe(
        Stream.flatMap(({ events, enqueued }) =>
          Stream.concat(
            Stream.fromIterable(events),
            enqueued
              ? Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain)
              : Stream.empty,
          ),
        ),
      );
    },
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, { events: [normalizeLegacyEvent(event)] }));
  };

  const emitAndWaitForEnqueue = Effect.fnUntraced(function* (
    events: ReadonlyArray<LegacyProviderRuntimeEvent>,
  ) {
    const enqueued = yield* Deferred.make<void>();
    yield* PubSub.publish(runtimeEventPubSub, {
      events: events.map(normalizeLegacyEvent),
      enqueued,
    });
    yield* Deferred.await(enqueued);
  });

  return {
    service,
    emit,
    emitAndWaitForEnqueue,
    setSession,
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: {
    serverSettings?: Partial<ServerSettings>;
    threadTitle?: string;
    workspaceSubdirectory?: string;
    captureLogs?: boolean;
  }) {
    const repositoryRoot = makeTempDir("t3-provider-project-");
    NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    const workspaceRoot = NodePath.join(repositoryRoot, options?.workspaceSubdirectory ?? "");
    NodeFS.mkdirSync(workspaceRoot, { recursive: true });
    const provider = createProviderServiceHarness();
    const sqlCounter = makeSqlStatementCounter();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const ingestionProjectionSnapshotLayer = Layer.effect(
      ProjectionSnapshotQuery,
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        return ProjectionSnapshotQuery.of({
          ...query,
          getThreadDetailById: () =>
            Effect.die("provider runtime ingestion must not hydrate thread detail"),
        });
      }),
    ).pipe(Layer.provide(projectionSnapshotLayer));
    // Real clock plus an offset the test can advance, so delivery pacing in
    // ingestion can be driven without sleeping. Sleeps stay real.
    let clockOffsetMs = 0;
    const realClock = Effect.runSync(Effect.service(Clock.Clock));
    const shiftedClock: Clock.Clock = {
      currentTimeMillisUnsafe: () => realClock.currentTimeMillisUnsafe() + clockOffsetMs,
      currentTimeMillis: Effect.sync(() => realClock.currentTimeMillisUnsafe() + clockOffsetMs),
      currentTimeNanosUnsafe: () =>
        realClock.currentTimeNanosUnsafe() + BigInt(clockOffsetMs) * 1_000_000n,
      currentTimeNanos: Effect.sync(
        () => realClock.currentTimeNanosUnsafe() + BigInt(clockOffsetMs) * 1_000_000n,
      ),
      monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: realClock.monotonicTimeNanos,
      sleep: (duration) => realClock.sleep(duration),
    };
    const capturedLogs: Array<string> = [];
    const logCaptureLayer =
      options?.captureLogs === true
        ? Logger.layer(
            [
              Logger.make(({ message }) => {
                const entries: ReadonlyArray<unknown> = Array.isArray(message)
                  ? message
                  : [message];
                capturedLogs.push(entries.map((entry) => String(entry)).join(" "));
              }),
            ],
            { mergeWithExisting: false },
          )
        : Layer.empty;
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provide(Layer.succeed(Clock.Clock, shiftedClock)),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(ingestionProjectionSnapshotLayer),
      // Single shared liveness instance across ingestion (writer), the
      // engine, and the snapshot query (reader).
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(Tracer.Tracer, sqlCounter.tracer)),
      Layer.provideMerge(logCaptureLayer),
    );
    const testRuntime = ManagedRuntime.make(layer);
    runtime = testRuntime;
    const engine = await testRuntime.runPromise(Effect.service(OrchestrationEngineService));
    const sqlClient = await testRuntime.runPromise(Effect.service(SqlClient.SqlClient));
    let failNextDispatch: ((command: OrchestrationCommand) => boolean) | undefined;
    const originalEngineDispatch = engine.dispatch;
    Object.defineProperty(engine, "dispatch", {
      configurable: true,
      value: (
        command: OrchestrationCommand,
        dispatchOptions?: Parameters<typeof originalEngineDispatch>[1],
      ) => {
        if (failNextDispatch?.(command)) {
          failNextDispatch = undefined;
          return Effect.die(new Error("injected transient orchestration dispatch failure"));
        }
        return originalEngineDispatch(command, dispatchOptions);
      },
    });
    const snapshotQuery = await testRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await testRuntime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await testRuntime.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => testRuntime.runPromise(ingestion.drain);
    const restartIngestionRecovery = () =>
      testRuntime.runPromise(ingestion.start().pipe(Scope.provide(scope!)));
    const readPendingTurnStart = (threadId: ThreadId) =>
      testRuntime.runPromise(
        Effect.service(ProjectionTurnRepository).pipe(
          Effect.flatMap((repository) => repository.getPendingTurnStartByThreadId({ threadId })),
        ),
      );
    const readLatestTurnById = (threadId: ThreadId, id: TurnId) =>
      testRuntime.runPromise(
        Effect.service(ProjectionTurnRepository).pipe(
          Effect.flatMap((repository) => repository.getByTurnId({ threadId, turnId: id })),
        ),
      );
    const dispatch = (command: OrchestrationCommand) =>
      testRuntime.runPromise(engine.dispatch(command));
    const emitAndDrain = (events: ReadonlyArray<LegacyProviderRuntimeEvent>) =>
      testRuntime.runPromise(
        provider.emitAndWaitForEnqueue(events).pipe(Effect.andThen(ingestion.drain)),
      );

    const createdAt = "2026-01-01T00:00:00.000Z";
    await dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-provider-project-create"),
      projectId: asProjectId("project-1"),
      title: "Provider Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    });
    await dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: ThreadId.make("thread-1"),
      projectId: asProjectId("project-1"),
      title: options?.threadTitle ?? "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: createdAt,
        lastError: null,
      },
      createdAt,
    });
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      dispatch,
      failNextDispatch: (predicate: (command: OrchestrationCommand) => boolean) => {
        failNextDispatch = predicate;
      },
      seedReadySummary: (childThreadId: ThreadId, turnId: TurnId, completedAt: string) =>
        testRuntime.runPromise(sqlClient`
          INSERT INTO projection_delegated_task_summaries (
            child_thread_id, parent_environment_id, parent_thread_id, source_turn_id, completed_at,
            summary_text, source, source_turn_ids_json, watermark, content_fingerprint, state,
            error, attempt_count, retry_after, updated_at
          ) VALUES (
            ${childThreadId}, 'test-environment', 'thread-1', ${turnId}, ${completedAt},
            'Outcome: already summarized.', 'deterministic', ${JSON.stringify([turnId])}, 1,
            'preexisting-summary', 'ready', NULL, 1, NULL, ${completedAt}
          )
        `),
      restartIngestionRecovery,
      readModel: () => testRuntime.runPromise(snapshotQuery.getSnapshot()),
      readThreadShell: () =>
        testRuntime.runPromise(
          snapshotQuery
            .getThreadShellById(asThreadId("thread-1"))
            .pipe(Effect.map(Option.getOrThrow)),
        ),
      emit: provider.emit,
      advanceClock: (ms: number) => {
        clockOffsetMs += ms;
      },
      emitAndDrain,
      readPendingTurnStart,
      readLatestTurnById,
      logs: capturedLogs,
      sqlCount: sqlCounter.count,
      setProviderSession: provider.setSession,
      drain,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("persists provider-reported model evidence for the exact delegated turn", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("delegated-turn-1");
    const messageId = asMessageId("delegated-message-1");
    const providerInstanceId = ProviderInstanceId.make("opencode");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-delegation-lineage"),
      threadId,
      activity: {
        id: asEventId("delegation-lineage"),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated task created",
        payload: {
          version: 1,
          taskId: threadId,
          childThreadId: threadId,
          delegatedMessageId: messageId,
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-delegated-turn-start"),
      threadId,
      message: {
        messageId,
        role: "user",
        text: "Reply with CHILD_OK",
        attachments: [],
      },
      modelSelection: {
        instanceId: providerInstanceId,
        model: "opencode-go/deepseek-v4-flash",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("evt-delegated-turn-started"),
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId,
        threadId,
        createdAt,
        turnId,
        payload: { model: "opencode-go/deepseek-v4-flash" },
      },
    ]);

    let thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.find((activity) => activity.kind === "delegation.model-observed")?.payload,
    ).toMatchObject({
      taskId: threadId,
      delegatedMessageId: messageId,
      delegatedTurnId: turnId,
      model: "opencode-go/deepseek-v4-flash",
      evidence: "provider-executed",
    });

    await harness.emitAndDrain([
      {
        type: "model.rerouted",
        eventId: asEventId("evt-delegated-model-rerouted"),
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId,
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        payload: {
          fromModel: "opencode-go/deepseek-v4-flash",
          toModel: "opencode-go/deepseek-v4-pro",
          reason: "upstream reroute",
        },
      },
    ]);

    thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.findLast((activity) => activity.kind === "delegation.model-observed")
        ?.payload,
    ).toMatchObject({
      taskId: threadId,
      delegatedMessageId: messageId,
      delegatedTurnId: turnId,
      model: "opencode-go/deepseek-v4-pro",
      evidence: "provider-rerouted",
    });
  });

  it("announces a delegated terminal turn on its parent exactly once", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const delegatedTurnId = asTurnId("delegated-turn-1");
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("parent-running"),
      threadId: parentThreadId,
      session: {
        threadId: parentThreadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: asTurnId("parent-turn"),
        updatedAt: now,
        lastError: null,
      },
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("child-create"),
      threadId: childThreadId,
      projectId: asProjectId("project-1"),
      title: "Child",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("child-lineage"),
      threadId: childThreadId,
      activity: {
        id: asEventId("child-lineage"),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated task created",
        payload: {
          version: 1,
          taskId: childThreadId,
          childThreadId,
          parentEnvironmentId: "test-environment",
          parentThreadId,
          delegatedMessageId,
          role: "general",
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("child-turn-start"),
      threadId: childThreadId,
      message: {
        messageId: delegatedMessageId,
        role: "user",
        text: "Do the child work.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    const dummySecret = `ghp_${"DUMMYSECRET".repeat(4)}`;
    const oversizedTail = "TRAILING_REPORT_TEXT_SHOULD_NOT_LEAK ".repeat(60);
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("child-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: now,
        turnId: delegatedTurnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "content.delta",
        eventId: asEventId("child-answer"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: now,
        turnId: delegatedTurnId,
        itemId: asItemId("child-answer-item"),
        payload: {
          streamKind: "assistant_text",
          delta: `${dummySecret} ${"report ".repeat(40)}${oversizedTail}`,
        },
      },
      {
        type: "turn.completed",
        eventId: asEventId("child-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: delegatedTurnId,
        payload: { state: "completed" },
      },
    ]);
    await harness.emitAndDrain([
      {
        type: "turn.completed",
        eventId: asEventId("child-turn-completed-replay"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: delegatedTurnId,
        payload: { state: "completed" },
      },
    ]);

    const readModel = await harness.readModel();
    const parent = readModel.threads.find((thread) => thread.id === parentThreadId);
    const completionActivities = parent?.activities.filter(
      (activity) => activity.kind === "delegation.completed",
    );
    expect(completionActivities).toHaveLength(1);
    expect(completionActivities?.[0]?.payload).toMatchObject({
      childThreadId,
      delegatedTurnId,
      status: "completed",
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    const persistedParentActivity = JSON.stringify(completionActivities?.[0]?.payload);
    const persistedParentMessage = parent?.messages.find((message) => message.role === "system");
    expect(persistedParentActivity).not.toContain(dummySecret);
    expect(persistedParentMessage?.text).not.toContain(dummySecret);
    expect(persistedParentActivity).not.toContain("TRAILING_REPORT_TEXT_SHOULD_NOT_LEAK");
    expect(persistedParentMessage?.text).not.toContain("TRAILING_REPORT_TEXT_SHOULD_NOT_LEAK");
    expect(
      (completionActivities?.[0]?.payload as { resultExcerpt?: string }).resultExcerpt?.length,
    ).toBeLessThanOrEqual(200);
    expect(completionActivities?.[0]?.payload).toMatchObject({
      resultExcerpt: expect.stringContaining("[REDACTED]"),
    });
    expect(persistedParentMessage?.text).toContain("task_read");
    expect(persistedParentMessage?.text).toContain(String(childThreadId));
    expect(persistedParentMessage?.text.length).toBeLessThan(400);
    expect(parent?.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(parent?.latestTurn).toMatchObject({
      turnId: asTurnId("parent-turn"),
      state: "running",
    });
    expect(parent?.session?.activeTurnId).toBe(asTurnId("parent-turn"));
  });

  it("isolates executor completion notifications to the Coordinator", async () => {
    const harness = await createHarness();
    const coordinatorThreadId = asThreadId("thread-1");
    const architectThreadId = asThreadId("arch:notify-isolation");
    const childThreadId = asThreadId("child-notify-isolation");
    const delegatedTurnId = asTurnId("notify-isolation-turn");
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("notify-isolation-architect-create"),
      threadId: architectThreadId,
      projectId: asProjectId("project-1"),
      title: "Architect",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    const ordinaryArchitectTurnId = asTurnId("architect-ordinary-turn");
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("notify-isolation-ordinary-turn"),
      threadId: architectThreadId,
      message: {
        messageId: asMessageId("notify-isolation-ordinary-message"),
        role: "user",
        text: "A normal Architect conversation must not notify the Coordinator.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("notify-isolation-ordinary-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: architectThreadId,
        createdAt: now,
        turnId: ordinaryArchitectTurnId,
        payload: { model: "gpt-5" },
      },
      {
        type: "content.delta",
        eventId: asEventId("notify-isolation-ordinary-answer"),
        provider: ProviderDriverKind.make("codex"),
        threadId: architectThreadId,
        createdAt: "2026-01-01T00:00:00.500Z",
        turnId: ordinaryArchitectTurnId,
        itemId: asItemId("notify-isolation-ordinary-answer-item"),
        payload: { streamKind: "assistant_text", delta: "Still no Coordinator notice." },
      },
      {
        type: "turn.completed",
        eventId: asEventId("notify-isolation-ordinary-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: architectThreadId,
        createdAt: "2026-01-01T00:00:00.750Z",
        turnId: ordinaryArchitectTurnId,
        payload: { state: "completed" },
      },
    ]);
    const beforeExecutorCompletion = await harness.readModel();
    const coordinatorBeforeExecutor = beforeExecutorCompletion.threads.find(
      (thread) => thread.id === coordinatorThreadId,
    );
    expect(
      coordinatorBeforeExecutor?.activities.some(
        (activity) => activity.kind === "delegation.completed",
      ),
    ).toBe(false);
    expect(
      coordinatorBeforeExecutor?.messages.filter((message) => message.role === "system"),
    ).toEqual([]);

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId: coordinatorThreadId,
      delegatedMessageId: asMessageId("notify-isolation-child-message"),
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });

    const model = await harness.readModel();
    const coordinator = model.threads.find((thread) => thread.id === coordinatorThreadId);
    const architect = model.threads.find((thread) => thread.id === architectThreadId);
    expect(
      coordinator?.activities.some((activity) => activity.kind === "delegation.completed"),
    ).toBe(true);
    expect(coordinator?.messages.some((message) => message.role === "system")).toBe(true);
    expect(
      coordinator?.messages.some(
        (message) => message.id === delegationWakeMessageId(childThreadId, delegatedTurnId),
      ),
    ).toBe(true);
    expect(architect?.activities).toEqual([]);
    expect(architect?.messages.some((message) => message.role === "system")).toBe(false);
    expect(
      architect?.activities.some((activity) => activity.kind.startsWith("architecture.")),
    ).toBe(false);
    expect(
      architect?.messages.some((message) => String(message.id).startsWith("delegation-wake:")),
    ).toBe(false);
  });

  it("scrubs and caps a long terminal failure preview in parent activity and wake", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-failed-preview");
    const turnId = asTurnId("child-failed-turn");
    const now = "2026-01-01T00:00:00.000Z";
    const dummySecret = `ghp_${"FAILURESECRET".repeat(3)}`;
    const discardedTail = "FAILURE_PREVIEW_TAIL_SHOULD_NOT_PERSIST ".repeat(40);
    const terminalError = `${dummySecret} ${"provider failure detail ".repeat(20)}${discardedTail}`;

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("child-failed-message"),
      createdAt: now,
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("child-failed-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: now,
        turnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("child-failed-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        payload: { state: "failed", errorMessage: terminalError },
      },
    ]);

    const parent = (await harness.readModel()).threads.find(
      (thread) => thread.id === parentThreadId,
    );
    const completion = parent?.activities.find(
      (activity) => activity.kind === "delegation.completed",
    );
    const storedError = (completion?.payload as { readonly terminalError?: string }).terminalError;
    const wake = parent?.messages.find(
      (message) => message.id === delegationWakeMessageId(childThreadId, turnId),
    );
    const wakePreview = wake?.text.match(/Preview: ([\s\S]*?)\. Full child transcript:/)?.[1];

    expect(storedError).toHaveLength(200);
    expect(wakePreview).toHaveLength(200);
    expect(storedError).toContain("[REDACTED]");
    expect(storedError).not.toContain(dummySecret);
    expect(storedError).not.toContain("FAILURE_PREVIEW_TAIL_SHOULD_NOT_PERSIST");
    expect(wake?.text).toContain("[REDACTED]");
    expect(wake?.text).not.toContain(dummySecret);
    expect(wake?.text).not.toContain("FAILURE_PREVIEW_TAIL_SHOULD_NOT_PERSIST");
    expect(JSON.stringify(completion?.payload)).not.toContain(dummySecret);
  });

  it("replays the parent callback and wake from a terminal child after a callback crash gap", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-crash-gap");
    const turnId = asTurnId("child-terminal-turn");
    const now = "2026-01-01T00:00:00.000Z";
    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("child-crash-gap-message"),
      createdAt: now,
    });
    harness.failNextDispatch(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "delegation.completed",
    );
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });

    let parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(
      parent?.activities.filter((activity) => activity.kind === "delegation.completed"),
    ).toHaveLength(0);
    expect(
      parent?.messages.some(
        (message) => message.id === delegationWakeMessageId(childThreadId, turnId),
      ),
    ).toBe(false);
    // This is the reviewer's crash window: the summary projection completed,
    // but terminal child notification had not yet reached the parent.
    await harness.seedReadySummary(childThreadId, turnId, "2026-01-01T00:00:01.000Z");

    // A fresh startup recovery pass derives the lost callback from the durable terminal turn.
    await harness.restartIngestionRecovery();
    const parentAfterRecovery = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.activities.some((activity) => activity.kind === "delegation.completed") &&
        thread.messages.some(
          (message) => message.id === delegationWakeMessageId(childThreadId, turnId),
        ) &&
        thread.messages.some(
          (message) =>
            message.id ===
            asMessageId(`delegation-wake-turn:${delegatedChildTurnKey(childThreadId, turnId)}`),
        ),
    );
    expect(
      parentAfterRecovery.activities.filter((activity) => activity.kind === "delegation.completed"),
    ).toHaveLength(1);

    await harness.restartIngestionRecovery();
    await Effect.runPromise(Effect.sleep("100 millis"));
    parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(
      parent?.activities.filter((activity) => activity.kind === "delegation.completed"),
    ).toHaveLength(1);
    expect(
      parent?.messages.filter(
        (message) =>
          message.id ===
          asMessageId(`delegation-wake-turn:${delegatedChildTurnKey(childThreadId, turnId)}`),
      ),
    ).toHaveLength(1);
  });

  it("does not backfill a historical legacy completion with a durable wake-turn anchor after restart", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-legacy-delivered");
    const turnId = asTurnId("legacy-delivered-turn");
    const completedAt = "2026-01-01T00:00:01.000Z";
    const legacyWakeMessageId = asMessageId(`delegation-wake:${turnId}`);
    const compositeWakeMessageId = delegationWakeMessageId(childThreadId, turnId);
    const directTurnMessageId = asMessageId(`delegation-wake-turn:${childThreadId}:${turnId}`);
    const completionActivityId = `provider:delegation-completed:${delegatedChildTurnKey(childThreadId, turnId)}`;

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("legacy-delivered-message"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    harness.failNextDispatch(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "delegation.completed",
    );
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnId,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt,
    });
    await harness.seedReadySummary(childThreadId, turnId, completedAt);

    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`${completionActivityId}:append`),
      threadId: parentThreadId,
      activity: {
        id: EventId.make(completionActivityId),
        tone: "info",
        kind: "delegation.completed",
        summary: "Delegated child completed",
        payload: {
          version: 1,
          childThreadId,
          delegatedTurnId: turnId,
          status: "completed",
          completedAt,
          resultExcerpt: "Historical result already delivered.",
        },
        turnId: null,
        createdAt: completedAt,
      },
      createdAt: completedAt,
    });
    await harness.dispatch({
      type: "thread.message.system.append",
      commandId: CommandId.make("legacy-delivered-wake-message"),
      threadId: parentThreadId,
      message: {
        messageId: legacyWakeMessageId,
        text: "Delegated child completed. Preview: Historical result already delivered.",
      },
      createdAt: completedAt,
    });
    await harness.dispatch({
      type: "thread.message.user.append",
      commandId: CommandId.make("legacy-delivered-wake-turn-anchor"),
      threadId: parentThreadId,
      message: {
        messageId: directTurnMessageId,
        text: "Historical child completion wake turn.",
        attachments: [],
      },
      createdAt: completedAt,
    });

    await harness.restartIngestionRecovery();
    await harness.drain();

    const parent = (await harness.readModel()).threads.find(
      (thread) => thread.id === parentThreadId,
    );
    expect(parent?.messages.some((message) => message.id === legacyWakeMessageId)).toBe(true);
    expect(parent?.messages.some((message) => message.id === compositeWakeMessageId)).toBe(false);
    expect(parent?.messages.some((message) => message.id === directTurnMessageId)).toBe(true);
    expect(
      parent?.messages.some((message) => String(message.id).startsWith("delegation-wake-drain:")),
    ).toBe(false);
    expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);
  });

  it("retries a transient parent auto-start failure without creating duplicate parent turns", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-start-retry");
    const turnId = asTurnId("child-start-retry-turn");
    const now = "2026-01-01T00:00:00.000Z";
    const parentAnchorId = asMessageId(
      `delegation-wake-turn:${delegatedChildTurnKey(childThreadId, turnId)}`,
    );
    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("child-start-retry-message"),
      createdAt: now,
    });
    harness.failNextDispatch(
      (command) =>
        command.type === "thread.turn.start" && command.message.messageId === parentAnchorId,
    );
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    let parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(
      parent?.activities.filter((activity) => activity.kind === "delegation.completed"),
    ).toHaveLength(1);
    expect(parent?.messages.some((message) => message.id === parentAnchorId)).toBe(false);

    await harness.restartIngestionRecovery();
    await waitForThread(harness.readModel, (thread) =>
      thread.messages.some((message) => message.id === parentAnchorId),
    );
    await harness.restartIngestionRecovery();
    await Effect.runPromise(Effect.sleep("100 millis"));
    parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(
      parent?.activities.filter((activity) => activity.kind === "delegation.completed"),
    ).toHaveLength(1);
    expect(parent?.messages.filter((message) => message.id === parentAnchorId)).toHaveLength(1);
  });

  it("auto-starts a parent turn for an idle parent when the child terminal lands", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const delegatedTurnId = asTurnId("delegated-turn-1");
    const anchorMessageId = asMessageId(
      `delegation-wake-turn:${delegatedChildTurnKey(childThreadId, delegatedTurnId)}`,
    );
    const anchorText =
      "A delegated child finished. Read the bounded preview above. If it is insufficient for your decision, use task_read with the child task ID to read the full transcript.";
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("child-create"),
      threadId: childThreadId,
      projectId: asProjectId("project-1"),
      title: "Child",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("child-lineage"),
      threadId: childThreadId,
      activity: {
        id: asEventId("child-lineage"),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated task created",
        payload: {
          version: 1,
          taskId: childThreadId,
          childThreadId,
          parentEnvironmentId: "test-environment",
          parentThreadId,
          delegatedMessageId,
          role: "general",
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("child-turn-start"),
      threadId: childThreadId,
      message: {
        messageId: delegatedMessageId,
        role: "user",
        text: "Do the child work.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("child-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: now,
        turnId: delegatedTurnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("child-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: delegatedTurnId,
        payload: { state: "completed" },
      },
    ]);

    let thread = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ id: anchorMessageId, text: anchorText, turnId: null }),
    ]);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(anchorMessageId);

    await harness.emitAndDrain([
      {
        type: "turn.completed",
        eventId: asEventId("child-turn-completed-replay"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: delegatedTurnId,
        payload: { state: "completed" },
      },
    ]);
    thread = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const pendingStartAfterReplay = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStartAfterReplay)).toBe(true);
    expect(Option.getOrThrow(pendingStartAfterReplay).messageId).toBe(anchorMessageId);
  });

  it.each([
    {
      variant: "a running parent turn" as const,
      busy: async (harness: Awaited<ReturnType<typeof createHarness>>): Promise<TurnId | null> => {
        await harness.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("parent-running"),
          threadId: asThreadId("thread-1"),
          session: {
            threadId: asThreadId("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("parent-turn"),
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastError: null,
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return asTurnId("parent-turn");
      },
    },
    {
      variant: "a queued parent turn start" as const,
      busy: async (harness: Awaited<ReturnType<typeof createHarness>>): Promise<TurnId | null> => {
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("parent-pending-start"),
          threadId: asThreadId("thread-1"),
          message: {
            messageId: asMessageId("parent-pending-message"),
            role: "user",
            text: "Queued parent prompt.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return null;
      },
    },
  ])("does not auto-start a parent turn for $variant", async ({ busy }) => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const delegatedTurnId = asTurnId("delegated-turn-1");
    const anchorMessageId = asMessageId(
      `delegation-wake-turn:${delegatedChildTurnKey(childThreadId, delegatedTurnId)}`,
    );
    const now = "2026-01-01T00:00:00.000Z";

    const pendingStartOwnerTurnId = await busy(harness);

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("child-create"),
      threadId: childThreadId,
      projectId: asProjectId("project-1"),
      title: "Child",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("child-lineage"),
      threadId: childThreadId,
      activity: {
        id: asEventId("child-lineage"),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated task created",
        payload: {
          version: 1,
          taskId: childThreadId,
          childThreadId,
          parentEnvironmentId: "test-environment",
          parentThreadId,
          delegatedMessageId,
          role: "general",
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("child-turn-start"),
      threadId: childThreadId,
      message: {
        messageId: delegatedMessageId,
        role: "user",
        text: "Do the child work.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("child-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: now,
        turnId: delegatedTurnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("child-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: delegatedTurnId,
        payload: { state: "completed" },
      },
    ]);

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(thread?.messages.some((message) => message.id === anchorMessageId)).toBe(false);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    if (pendingStartOwnerTurnId === null) {
      expect(Option.isSome(pendingStart)).toBe(true);
      expect(Option.getOrThrow(pendingStart).messageId).toBe(asMessageId("parent-pending-message"));
    } else {
      expect(Option.isNone(pendingStart)).toBe(true);
    }
  });

  it("does not wake an ordinary terminal turn or fail when lineage is missing", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("ordinary-turn");
    const messageId = asMessageId("ordinary-message");
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("ordinary-turn-start"),
      threadId,
      message: { messageId, role: "user", text: "ordinary", attachments: [] },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("ordinary-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: now,
        turnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("ordinary-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        payload: { state: "completed" },
      },
    ]);

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.activities.some((activity) => activity.kind === "delegation.completed")).toBe(
      false,
    );
    expect(thread?.messages.some((message) => message.role === "system")).toBe(false);
  });

  it("does not fail a child terminal when its delegated parent cannot be resolved", async () => {
    const harness = await createHarness({ captureLogs: true });
    const childThreadId = asThreadId("orphan-child");
    const delegatedMessageId = asMessageId("orphan-message");
    const delegatedTurnId = asTurnId("orphan-turn");
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("orphan-child-create"),
      threadId: childThreadId,
      projectId: asProjectId("project-1"),
      title: "Orphan child",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("orphan-child-lineage"),
      threadId: childThreadId,
      activity: {
        id: asEventId("orphan-child-lineage"),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated task created",
        payload: {
          version: 1,
          taskId: childThreadId,
          childThreadId,
          parentEnvironmentId: "test-environment",
          parentThreadId: asThreadId("missing-parent"),
          delegatedMessageId,
          role: "general",
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("orphan-child-turn-start"),
      threadId: childThreadId,
      message: {
        messageId: delegatedMessageId,
        role: "user",
        text: "Finish without a parent row.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await expect(
      harness.emitAndDrain([
        {
          type: "turn.started",
          eventId: asEventId("orphan-child-started"),
          provider: ProviderDriverKind.make("codex"),
          threadId: childThreadId,
          createdAt: now,
          turnId: delegatedTurnId,
          payload: { model: "gpt-5-codex" },
        },
        {
          type: "turn.completed",
          eventId: asEventId("orphan-child-completed"),
          provider: ProviderDriverKind.make("codex"),
          threadId: childThreadId,
          createdAt: "2026-01-01T00:00:01.000Z",
          turnId: delegatedTurnId,
          payload: { state: "completed" },
        },
      ]),
    ).resolves.toBe(0);

    expect(harness.logs.some((entry) => entry.includes("failed to wake delegation parent"))).toBe(
      true,
    );

    const child = (await harness.readModel()).threads.find((thread) => thread.id === childThreadId);
    expect(child?.latestTurn).toMatchObject({
      turnId: delegatedTurnId,
      state: "completed",
    });
  });

  it("keeps completion activities and wakes distinct when children reuse a turn ID", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childA = asThreadId("child-same-turn-a");
    const childB = asThreadId("child-same-turn-b");
    const turnId = asTurnId("provider-reused-turn");
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    for (const [childThreadId, suffix] of [
      [childA, "a"],
      [childB, "b"],
    ] as const) {
      await seedDelegatedChild(harness, {
        childThreadId,
        parentThreadId,
        delegatedMessageId: asMessageId(`same-turn-message-${suffix}`),
        createdAt: now,
      });
      await completeDelegatedChild(harness, {
        childThreadId,
        delegatedTurnId: turnId,
        startedAt: now,
        completedAt: `2026-01-01T00:00:0${suffix === "a" ? "1" : "2"}.000Z`,
      });
    }

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const completions = parent?.activities.filter(
      (activity) => activity.kind === "delegation.completed",
    );
    expect(completions).toHaveLength(2);
    expect(
      completions?.map(
        (activity) => (activity.payload as { childThreadId: ThreadId }).childThreadId,
      ),
    ).toEqual([childA, childB]);
    expect(
      completions?.map(
        (activity) => (activity.payload as { delegatedTurnId: TurnId }).delegatedTurnId,
      ),
    ).toEqual([turnId, turnId]);
    expect(parent?.messages.filter((message) => message.role === "system")).toHaveLength(2);
    expect(
      parent?.messages.some((message) => message.id === delegationWakeMessageId(childA, turnId)),
    ).toBe(true);
    expect(
      parent?.messages.some((message) => message.id === delegationWakeMessageId(childB, turnId)),
    ).toBe(true);
  });

  type WakeHarness = Awaited<ReturnType<typeof createHarness>>;
  const WAKE_ANCHOR_TEXT =
    "A delegated child finished. Read the bounded preview above. If it is insufficient for your decision, use task_read with the child task ID to read the full transcript.";

  async function seedDelegatedChild(
    harness: WakeHarness,
    input: {
      readonly childThreadId: ThreadId;
      readonly parentThreadId: ThreadId;
      readonly delegatedMessageId: MessageId;
      readonly createdAt: string;
    },
  ) {
    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${input.childThreadId}-create`),
      threadId: input.childThreadId,
      projectId: asProjectId("project-1"),
      title: "Child",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    });
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`${input.childThreadId}-lineage`),
      threadId: input.childThreadId,
      activity: {
        id: asEventId(`${input.childThreadId}-lineage`),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated task created",
        payload: {
          version: 1,
          taskId: input.childThreadId,
          childThreadId: input.childThreadId,
          parentEnvironmentId: "test-environment",
          parentThreadId: input.parentThreadId,
          delegatedMessageId: input.delegatedMessageId,
          role: "general",
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${input.childThreadId}-turn-start`),
      threadId: input.childThreadId,
      message: {
        messageId: input.delegatedMessageId,
        role: "user",
        text: "Do the child work.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: input.createdAt,
    });
  }

  async function completeDelegatedChild(
    harness: WakeHarness,
    input: {
      readonly childThreadId: ThreadId;
      readonly delegatedTurnId: TurnId;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly outputStatus?: "available" | "empty" | "unavailable";
    },
  ) {
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId(`${input.childThreadId}:${input.delegatedTurnId}-started`),
        provider: ProviderDriverKind.make("codex"),
        threadId: input.childThreadId,
        createdAt: input.startedAt,
        turnId: input.delegatedTurnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId(`${input.childThreadId}:${input.delegatedTurnId}-completed`),
        provider: ProviderDriverKind.make("codex"),
        threadId: input.childThreadId,
        createdAt: input.completedAt,
        turnId: input.delegatedTurnId,
        payload: {
          state: "completed",
          ...(input.outputStatus === undefined ? {} : { outputStatus: input.outputStatus }),
        },
      },
    ]);
  }

  async function occupyParent(
    harness: WakeHarness,
    parentThreadId: ThreadId,
    parentTurnId: TurnId,
    createdAt: string,
  ) {
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${parentTurnId}-running`),
      threadId: parentThreadId,
      session: {
        threadId: parentThreadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: parentTurnId,
        updatedAt: createdAt,
        lastError: null,
      },
      createdAt,
    });
  }

  async function settleParent(
    harness: WakeHarness,
    parentThreadId: ThreadId,
    parentTurnId: TurnId,
    createdAt: string,
    eventTag = "completed",
    terminalType: "turn.completed" | "turn.aborted" = "turn.completed",
  ) {
    await harness.emitAndDrain([
      terminalType === "turn.completed"
        ? {
            type: "turn.completed",
            eventId: asEventId(`${parentTurnId}-${eventTag}`),
            provider: ProviderDriverKind.make("codex"),
            threadId: parentThreadId,
            createdAt,
            turnId: parentTurnId,
            payload: { state: "completed" },
          }
        : {
            type: "turn.aborted",
            eventId: asEventId(`${parentTurnId}-${eventTag}`),
            provider: ProviderDriverKind.make("codex"),
            threadId: parentThreadId,
            createdAt,
            turnId: parentTurnId,
            payload: { reason: "Interrupted by user." },
          },
    ]);
  }

  const userMessageIds = (messages: ReadonlyArray<ProviderRuntimeTestMessage>) =>
    messages.filter((message) => message.role === "user").map((message) => message.id);

  // This legacy fixture models stored history; a newly started turn must use the current brief.
  async function seedBoardOrchestratorNotice(
    harness: WakeHarness,
    input: { readonly threadId: ThreadId; readonly createdAt: string },
  ) {
    await harness.dispatch({
      type: "thread.message.system.append",
      commandId: CommandId.make(`board-orchestrator:${input.threadId}`),
      threadId: input.threadId,
      message: {
        messageId: asMessageId(`board-orchestrator:${input.threadId}`),
        text: "You were marked as the orchestrator for this board.",
      },
      createdAt: input.createdAt,
    });
  }

  async function markBoardOrchestratorDelivered(
    harness: WakeHarness,
    input: { readonly threadId: ThreadId; readonly createdAt: string },
  ) {
    await harness.dispatch({
      type: "thread.message.user.append",
      commandId: CommandId.make(`board-orchestrator-turn:${input.threadId}`),
      threadId: input.threadId,
      message: {
        messageId: asMessageId(`board-orchestrator-turn:${input.threadId}`),
        text: BOARD_ORCHESTRATOR_TURN_TEXT,
        attachments: [],
      },
      createdAt: input.createdAt,
    });
  }

  async function seedBoardOrchestratorResendNotice(
    harness: WakeHarness,
    input: { readonly threadId: ThreadId; readonly nonce: string; readonly createdAt: string },
  ) {
    await harness.dispatch({
      type: "thread.message.system.append",
      commandId: CommandId.make(`board-orchestrator:${input.threadId}:${input.nonce}`),
      threadId: input.threadId,
      message: {
        messageId: asMessageId(`board-orchestrator:${input.threadId}:${input.nonce}`),
        text: "You were marked as the orchestrator for this board.",
      },
      createdAt: input.createdAt,
    });
  }

  async function seedBoardStartNotice(
    harness: WakeHarness,
    input: {
      readonly threadId: ThreadId;
      readonly cardId: string;
      readonly createdAt: string;
      readonly text?: string;
    },
  ) {
    await harness.dispatch({
      type: "thread.message.system.append",
      commandId: CommandId.make(`board-start:${input.cardId}`),
      threadId: input.threadId,
      message: {
        messageId: asMessageId(`board-start:${input.cardId}`),
        text: input.text ?? `Board card "${input.cardId}" started by the human.`,
      },
      createdAt: input.createdAt,
    });
  }

  async function markBoardStartDelivered(
    harness: WakeHarness,
    input: { readonly threadId: ThreadId; readonly cardId: string; readonly createdAt: string },
  ) {
    await harness.dispatch({
      type: "thread.message.user.append",
      commandId: CommandId.make(`board-start-turn:${input.cardId}`),
      threadId: input.threadId,
      message: {
        messageId: asMessageId(`board-start-turn:${input.cardId}`),
        text: `Board card "${input.cardId}" started by the human.`,
        attachments: [],
      },
      createdAt: input.createdAt,
    });
  }

  it("announces every terminal turn of a multi-turn delegated child", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const followUpMessageId = asMessageId("follow-up-message-1");
    const turnOne = asTurnId("delegated-turn-1");
    const turnTwo = asTurnId("delegated-turn-2");
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId,
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnOne,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("child-follow-up-start"),
      threadId: childThreadId,
      message: {
        messageId: followUpMessageId,
        role: "user",
        text: "Continue the work.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnTwo,
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    });

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const completionActivities = parent?.activities.filter(
      (activity) => activity.kind === "delegation.completed",
    );
    expect(completionActivities).toHaveLength(2);
    const systemMessages = parent?.messages.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(2);
  });

  it("tells the parent when delegated output is unavailable and was not replayed", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const delegatedTurnId = asTurnId("delegated-turn-1");
    const now = "2026-01-01T00:00:00.000Z";

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId,
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
      outputStatus: "unavailable",
    });

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const completion = parent?.activities.find(
      (activity) =>
        activity.kind === "delegation.completed" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "delegatedTurnId" in activity.payload &&
        activity.payload.delegatedTurnId === delegatedTurnId,
    );
    expect(completion?.payload).toMatchObject({
      outputStatus: "unavailable",
      resultExcerpt:
        "Assistant output unavailable; the provider turn completed and was not replayed.",
    });
    expect(parent?.messages.find((message) => message.role === "system")?.text).toContain(
      "Assistant output unavailable; the provider turn completed and was not replayed.",
    );
  });

  it("wakes the parent for a manual follow-up turn in the child", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const manualMessageId = asMessageId("manual-message-1");
    const turnOne = asTurnId("delegated-turn-1");
    const manualTurn = asTurnId("manual-turn-1");
    const now = "2026-01-01T00:00:00.000Z";

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId,
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnOne,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("manual-turn-start"),
      threadId: childThreadId,
      message: {
        messageId: manualMessageId,
        role: "user",
        text: "Manual follow-up.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("manual-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:02.000Z",
        turnId: manualTurn,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("manual-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:03.000Z",
        turnId: manualTurn,
        payload: { state: "completed" },
      },
    ]);

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const completionActivities = parent?.activities.filter(
      (activity) => activity.kind === "delegation.completed",
    );
    expect(completionActivities).toHaveLength(2);
  });

  it("replays exactly once per delegated turn", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const followUpMessageId = asMessageId("follow-up-message-1");
    const turnOne = asTurnId("delegated-turn-1");
    const turnTwo = asTurnId("delegated-turn-2");
    const now = "2026-01-01T00:00:00.000Z";

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId,
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnOne,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.emitAndDrain([
      {
        type: "turn.completed",
        eventId: asEventId("turn-1-replay"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: turnOne,
        payload: { state: "completed" },
      },
    ]);

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("child-follow-up-start"),
      threadId: childThreadId,
      message: {
        messageId: followUpMessageId,
        role: "user",
        text: "Continue.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnTwo,
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    });
    await harness.emitAndDrain([
      {
        type: "turn.completed",
        eventId: asEventId("turn-2-replay"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        createdAt: "2026-01-01T00:00:03.000Z",
        turnId: turnTwo,
        payload: { state: "completed" },
      },
    ]);

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const completionActivities = parent?.activities.filter(
      (activity) => activity.kind === "delegation.completed",
    );
    expect(completionActivities).toHaveLength(2);
    const systemMessages = parent?.messages.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(2);
  });

  it("drains multi-turn wakes one at a time after a busy parent settles", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedMessageId = asMessageId("delegated-message-1");
    const followUpMessageId = asMessageId("follow-up-message-1");
    const turnOne = asTurnId("delegated-turn-1");
    const turnTwo = asTurnId("delegated-turn-2");
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId,
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnOne,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("child-follow-up-start"),
      threadId: childThreadId,
      message: {
        messageId: followUpMessageId,
        role: "user",
        text: "Continue.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: turnTwo,
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
    });

    let parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const wakeOneId = delegationWakeMessageId(childThreadId, turnOne);
    const wakeTwoId = delegationWakeMessageId(childThreadId, turnTwo);
    expect(parent?.messages.some((m) => m.id === wakeOneId)).toBe(true);
    expect(parent?.messages.some((m) => m.id === wakeTwoId)).toBe(true);
    expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);

    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:04.000Z",
      "settled",
      "turn.completed",
    );

    parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    const drainOneId = asMessageId(
      `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childThreadId, turnOne)}`,
    );
    expect(parent?.messages.some((m) => m.id === drainOneId)).toBe(true);
  });

  it.each(["turn.completed", "turn.aborted"] as const)(
    "drains an undelivered wake with an auto-turn once the occupying %s settles",
    async (terminalType) => {
      const harness = await createHarness();
      const parentThreadId = asThreadId("thread-1");
      const childThreadId = asThreadId("child-thread-1");
      const delegatedMessageId = asMessageId("delegated-message-1");
      const delegatedTurnId = asTurnId("delegated-turn-1");
      const drainMessageId = asMessageId(
        `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childThreadId, delegatedTurnId)}`,
      );
      const now = "2026-01-01T00:00:00.000Z";

      await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
      await seedDelegatedChild(harness, {
        childThreadId,
        parentThreadId,
        delegatedMessageId,
        createdAt: now,
      });
      await completeDelegatedChild(harness, {
        childThreadId,
        delegatedTurnId,
        startedAt: now,
        completedAt: "2026-01-01T00:00:01.000Z",
      });

      // The child terminal only records the wake; the busy parent gets no turn.
      let parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
      expect(parent?.messages.some((message) => message.id === drainMessageId)).toBe(false);
      expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);

      await settleParent(
        harness,
        parentThreadId,
        asTurnId("parent-turn"),
        "2026-01-01T00:00:02.000Z",
        "settled",
        terminalType,
      );

      parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
      expect(parent?.messages.filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({ id: drainMessageId, text: WAKE_ANCHOR_TEXT, turnId: null }),
      ]);
      const pendingStart = await harness.readPendingTurnStart(parentThreadId);
      expect(Option.isSome(pendingStart)).toBe(true);
      expect(Option.getOrThrow(pendingStart).messageId).toBe(drainMessageId);
    },
  );

  it("does not drain when a terminal turn leaves no undelivered wake", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("ordinary-turn");
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("ordinary-turn-start"),
      threadId,
      message: {
        messageId: asMessageId("ordinary-message"),
        role: "user",
        text: "ordinary",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("ordinary-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: now,
        turnId,
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("ordinary-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId,
        payload: { state: "completed" },
      },
    ]);

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.some((message) => message.role === "system")).toBe(false);
    expect(
      thread?.messages.some((message) => String(message.id).startsWith("delegation-wake-drain:")),
    ).toBe(false);
    expect(Option.isNone(await harness.readPendingTurnStart(threadId))).toBe(true);
  });

  it("does not create a second drain turn for a replayed parent terminal", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedTurnId = asTurnId("delegated-turn-1");
    const drainMessageId = asMessageId(
      `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childThreadId, delegatedTurnId)}`,
    );
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("delegated-message-1"),
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:03.000Z",
      "replay",
    );

    let parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainMessageId]);

    // The drain turn runs and settles without a delivery marker: the same
    // deterministic command id must not start a second turn.
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("drain-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:04.000Z",
        turnId: asTurnId("drain-turn"),
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("drain-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:05.000Z",
        turnId: asTurnId("drain-turn"),
        payload: { state: "completed" },
      },
    ]);

    parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainMessageId]);
    expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);
  });

  it("does not drain or replay a delivered direct wake after its marker write was lost", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child:direct-wake");
    const childTurnId = asTurnId("child:direct-turn");
    const directTurnMessageId = asMessageId(
      `delegation-wake-turn:${delegatedChildTurnKey(childThreadId, childTurnId)}`,
    );
    const drainMessageId = asMessageId(
      `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childThreadId, childTurnId)}`,
    );
    const wakeMessageId = delegationWakeMessageId(childThreadId, childTurnId);
    const now = "2026-01-01T00:00:00.000Z";

    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("child-direct-message"),
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId: childTurnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });

    let parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(parent?.messages.some((message) => message.id === directTurnMessageId)).toBe(true);
    expect(parent?.messages.some((message) => message.id === wakeMessageId)).toBe(true);
    expect(
      parent?.activities.some((activity) => activity.kind === "delegation.wake-delivered"),
    ).toBe(false);

    // Provider sendTurn accepted this durable direct turn, but its later delivery
    // marker append was lost. A real terminal event followed by recovery must use
    // the direct-turn anchor as evidence and never start a second drain turn.
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("parent-direct-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:02.000Z",
        turnId: asTurnId("provider-parent-direct-turn"),
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("parent-direct-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:03.000Z",
        turnId: asTurnId("provider-parent-direct-turn"),
        payload: { state: "completed" },
      },
    ]);
    await harness.restartIngestionRecovery();
    await harness.drain();

    parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([directTurnMessageId]);
    expect(parent?.messages.some((message) => message.id === drainMessageId)).toBe(false);
    expect(
      parent?.activities.some((activity) => activity.kind === "delegation.wake-delivered"),
    ).toBe(false);
    expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);
  });

  it("drains the next undelivered wake after the first wake auto-turn settles", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    const turnA = asTurnId("turn-a");
    const turnB = asTurnId("turn-b");
    const childA = asThreadId("child-a");
    const childB = asThreadId("child-b");
    const wakeA = delegationWakeMessageId(childA, turnA);
    const drainA = asMessageId(
      `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childA, turnA)}`,
    );
    const drainB = asMessageId(
      `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childB, turnB)}`,
    );

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedDelegatedChild(harness, {
      childThreadId: childA,
      parentThreadId,
      delegatedMessageId: asMessageId("delegated-a"),
      createdAt: now,
    });
    await seedDelegatedChild(harness, {
      childThreadId: childB,
      parentThreadId,
      delegatedMessageId: asMessageId("delegated-b"),
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId: childA,
      delegatedTurnId: turnA,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await completeDelegatedChild(harness, {
      childThreadId: childB,
      delegatedTurnId: turnB,
      startedAt: now,
      completedAt: "2026-01-01T00:00:02.000Z",
    });

    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:03.000Z",
    );

    let parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainA]);

    // The reactor marks A's wake delivered when A's auto-turn starts.
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("wake-a-delivered"),
      threadId: parentThreadId,
      activity: {
        id: asEventId("wake-a-delivered"),
        tone: "info",
        kind: "delegation.wake-delivered",
        summary: "Delegated wake delivered",
        payload: { wakeMessageIds: [wakeA] },
        turnId: null,
        createdAt: "2026-01-01T00:00:04.000Z",
      },
      createdAt: "2026-01-01T00:00:04.000Z",
    });

    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("wake-auto-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:04.000Z",
        turnId: asTurnId("wake-auto-turn"),
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("wake-auto-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:05.000Z",
        turnId: asTurnId("wake-auto-turn"),
        payload: { state: "completed" },
      },
    ]);

    parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainA, drainB]);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(drainB);
  });

  it("drains an undelivered wake exactly once when the occupying turn completes", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const childThreadId = asThreadId("child-thread-1");
    const delegatedTurnId = asTurnId("delegated-turn-1");
    const drainMessageId = asMessageId(
      `delegation-wake-drain:${parentThreadId}:${delegatedChildTurnKey(childThreadId, delegatedTurnId)}`,
    );
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedDelegatedChild(harness, {
      childThreadId,
      parentThreadId,
      delegatedMessageId: asMessageId("delegated-message-1"),
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId,
      delegatedTurnId,
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(parent?.messages.filter((message) => message.id === drainMessageId)).toHaveLength(1);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainMessageId]);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(drainMessageId);
  });

  it("does not drain while another queued turn still occupies the thread", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const queuedMessageId = asMessageId("queued-parent-message");
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("queued-parent-turn"),
      threadId: parentThreadId,
      message: {
        messageId: queuedMessageId,
        role: "user",
        text: "Queued follow-up.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await seedDelegatedChild(harness, {
      childThreadId: asThreadId("child-thread-1"),
      parentThreadId,
      delegatedMessageId: asMessageId("delegated-message-1"),
      createdAt: now,
    });
    await completeDelegatedChild(harness, {
      childThreadId: asThreadId("child-thread-1"),
      delegatedTurnId: asTurnId("delegated-turn-1"),
      startedAt: now,
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(
      parent?.messages.some((message) => String(message.id).startsWith("delegation-wake-drain:")),
    ).toBe(false);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(queuedMessageId);
  });

  it("drains a board-start notice queued while the orchestrator was busy", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const drainMessageId = asMessageId(`board-start-drain:${parentThreadId}:card-1`);
    const now = "2026-01-01T00:00:00.000Z";
    const taskText = `${BOARD_ORCHESTRATOR_TURN_TEXT}\n\nCurrent card:\nBoard card "Restore the worker" (card-1) started by the human. Executor role: implementation.\n\nKeep the user request and acceptance conditions.`;

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedBoardStartNotice(harness, {
      threadId: parentThreadId,
      cardId: "card-1",
      createdAt: now,
      text: taskText,
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainMessageId]);
    const drainMessage = parent?.messages.find((message) => message.id === drainMessageId);
    expect(drainMessage?.text).toBe(taskText);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(drainMessageId);
  });

  it("does not drain a board-start notice already delivered by ws.ts", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedBoardStartNotice(harness, {
      threadId: parentThreadId,
      cardId: "card-1",
      createdAt: now,
    });
    await markBoardStartDelivered(harness, {
      threadId: parentThreadId,
      cardId: "card-1",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(
      parent?.messages.some((message) => String(message.id).startsWith("board-start-drain:")),
    ).toBe(false);
    expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);
  });

  it("drains a board-orchestrator notice queued while the orchestrator was busy", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const drainMessageId = asMessageId(`board-orchestrator-drain:${parentThreadId}`);
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedBoardOrchestratorNotice(harness, { threadId: parentThreadId, createdAt: now });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainMessageId]);
    const drainMessage = parent?.messages.find((message) => message.id === drainMessageId);
    expect(drainMessage?.text).toBe(BOARD_ORCHESTRATOR_TURN_TEXT);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(drainMessageId);
  });

  it("does not drain a board-orchestrator notice already delivered by ws.ts", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedBoardOrchestratorNotice(harness, { threadId: parentThreadId, createdAt: now });
    await markBoardOrchestratorDelivered(harness, {
      threadId: parentThreadId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:02.000Z",
    );

    const parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(
      parent?.messages.some((message) =>
        String(message.id).startsWith("board-orchestrator-drain:"),
      ),
    ).toBe(false);
    expect(Option.isNone(await harness.readPendingTurnStart(parentThreadId))).toBe(true);
  });

  it("drains the oldest orchestrator brief first, then a newer resend", async () => {
    const harness = await createHarness();
    const parentThreadId = asThreadId("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    const drainPrimary = asMessageId(`board-orchestrator-drain:${parentThreadId}`);
    const drainResend = asMessageId(`board-orchestrator-drain:${parentThreadId}:n1`);

    await occupyParent(harness, parentThreadId, asTurnId("parent-turn"), now);
    await seedBoardOrchestratorNotice(harness, { threadId: parentThreadId, createdAt: now });
    await seedBoardOrchestratorResendNotice(harness, {
      threadId: parentThreadId,
      nonce: "n1",
      createdAt: "2026-01-01T00:00:00.500Z",
    });
    await settleParent(
      harness,
      parentThreadId,
      asTurnId("parent-turn"),
      "2026-01-01T00:00:01.000Z",
    );

    let parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainPrimary]);

    // Settle the primary brief's auto-turn so the drain runs again.
    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("brief-auto-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:02.000Z",
        turnId: asTurnId("brief-auto-turn"),
        payload: { model: "gpt-5-codex" },
      },
      {
        type: "turn.completed",
        eventId: asEventId("brief-auto-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        createdAt: "2026-01-01T00:00:03.000Z",
        turnId: asTurnId("brief-auto-turn"),
        payload: { state: "completed" },
      },
    ]);

    parent = (await harness.readModel()).threads.find((entry) => entry.id === parentThreadId);
    expect(userMessageIds(parent?.messages ?? [])).toEqual([drainPrimary, drainResend]);
    const pendingStart = await harness.readPendingTurnStart(parentThreadId);
    expect(Option.isSome(pendingStart)).toBe(true);
    expect(Option.getOrThrow(pendingStart).messageId).toBe(drainResend);
  });

  it.each([
    { delivery: "buffered", responseStreamingMode: "paragraph" as const },
    { delivery: "streamed", responseStreamingMode: "token" as const },
  ])("settles OpenCode aborted turns and saves $delivery assistant text", async (settings) => {
    const harness = await createHarness({
      serverSettings: { responseStreamingMode: settings.responseStreamingMode },
    });
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("opencode-aborted-turn");
    const base = {
      provider: ProviderDriverKind.make("opencode"),
      threadId,
      turnId,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    harness.emit({ ...base, type: "turn.started", eventId: asEventId("opencode-started") });
    harness.emit({
      ...base,
      type: "content.delta",
      eventId: asEventId("opencode-partial-text"),
      itemId: asItemId("opencode-text-part"),
      payload: { streamKind: "assistant_text", delta: "Work before the stop." },
    });
    harness.emit({
      ...base,
      type: "turn.aborted",
      eventId: asEventId("opencode-aborted"),
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { reason: "Interrupted by user." },
    });

    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({
      status: "interrupted",
      activeTurnId: null,
      lastError: null,
    });
    expect(thread?.latestTurn).toMatchObject({
      turnId,
      state: "interrupted",
      completedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(thread?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        turnId,
        text: "Work before the stop.",
        streaming: false,
      }),
    ]);
  });

  it.each(["turn.completed", "turn.aborted"] as const)(
    "finalizes old buffered text on late %s without stopping the newer turn",
    async (terminalType) => {
      const harness = await createHarness({
        serverSettings: { responseStreamingMode: "paragraph" },
      });
      const threadId = asThreadId("thread-1");
      const oldTurnId = asTurnId("old-buffered-turn");
      const newTurnId = asTurnId("new-active-turn");
      const base = {
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
      };
      await harness.emitAndDrain([
        {
          ...base,
          type: "turn.started",
          eventId: asEventId("old-buffered-started"),
          turnId: oldTurnId,
        },
        {
          ...base,
          type: "content.delta",
          eventId: asEventId("old-buffered-delta"),
          turnId: oldTurnId,
          itemId: asItemId("old-buffered-message"),
          payload: { streamKind: "assistant_text", delta: "Keep the old answer." },
        },
      ]);
      await harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("start-new-while-old-finishes"),
        threadId,
        message: {
          messageId: asMessageId("new-turn-prompt"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: base.createdAt,
      });
      harness.setProviderSession({
        provider: base.provider,
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        createdAt: base.createdAt,
        updatedAt: base.createdAt,
        activeTurnId: newTurnId,
      });
      await harness.emitAndDrain([
        {
          ...base,
          type: "turn.started",
          eventId: asEventId("new-active-started"),
          turnId: newTurnId,
        },
        {
          ...base,
          type: terminalType,
          eventId: asEventId("old-buffered-terminal"),
          turnId: oldTurnId,
          payload:
            terminalType === "turn.completed"
              ? { state: "completed" }
              : { reason: "Interrupted by user." },
        },
      ]);
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.session).toMatchObject({ activeTurnId: newTurnId, status: "running" });
      expect(thread?.messages).toContainEqual(
        expect.objectContaining({
          turnId: oldTurnId,
          text: "Keep the old answer.",
          streaming: false,
        }),
      );
    },
  );

  it.each([
    { source: "the previous turn", turnId: asTurnId("opencode-stopped-turn") },
    { source: "an unspecified turn", turnId: undefined },
  ])("ignores late OpenCode aborts for $source across newer turns", async (lateAbort) => {
    const harness = await createHarness({
      serverSettings: { responseStreamingMode: "token" },
    });
    const threadId = asThreadId("thread-1");
    const stoppedTurnId = asTurnId("opencode-stopped-turn");
    const nextTurnId = asTurnId("opencode-next-turn");
    const base = {
      provider: ProviderDriverKind.make("opencode"),
      threadId,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    harness.emit({
      ...base,
      type: "turn.started",
      eventId: asEventId("opencode-first-started"),
      turnId: stoppedTurnId,
    });
    harness.emit({
      ...base,
      type: "turn.aborted",
      eventId: asEventId("opencode-first-aborted"),
      turnId: stoppedTurnId,
      payload: { reason: "Interrupted by user." },
    });
    harness.emit({
      ...base,
      type: "turn.started",
      eventId: asEventId("opencode-next-started"),
      turnId: nextTurnId,
    });
    harness.emit({
      ...base,
      type: "content.delta",
      eventId: asEventId("opencode-next-partial-text"),
      turnId: nextTurnId,
      itemId: asItemId("opencode-next-text-part"),
      payload: { streamKind: "assistant_text", delta: "The next turn is running." },
    });
    await harness.drain();

    harness.emit({
      ...base,
      type: "turn.aborted",
      eventId: asEventId("opencode-late-abort"),
      ...(lateAbort.turnId ? { turnId: lateAbort.turnId } : {}),
      payload: { reason: "Interrupted by user." },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({ status: "running", activeTurnId: nextTurnId });
    expect(thread?.latestTurn).toMatchObject({ turnId: nextTurnId, state: "running" });
    expect(thread?.messages).toEqual([
      expect.objectContaining({
        turnId: nextTurnId,
        text: "The next turn is running.",
        streaming: true,
      }),
    ]);

    harness.emit({
      ...base,
      type: "turn.completed",
      eventId: asEventId("opencode-next-completed"),
      turnId: nextTurnId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const pendingAt = "2026-01-01T00:00:03.000Z";
    for (const hasPendingStart of [false, true]) {
      if (hasPendingStart) {
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("opencode-pending-start"),
          threadId,
          message: {
            messageId: asMessageId("opencode-pending-message"),
            role: "user",
            text: "Start another turn.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: pendingAt,
        });
        harness.emit({
          ...base,
          type: "session.state.changed",
          eventId: asEventId("opencode-pending-starting"),
          createdAt: pendingAt,
          payload: { state: "starting" },
        });
      }
      harness.emit({
        ...base,
        type: "turn.aborted",
        eventId: asEventId(`opencode-late-abort-after-completion-${hasPendingStart}`),
        ...(lateAbort.turnId ? { turnId: lateAbort.turnId } : {}),
        createdAt: "2026-01-01T00:00:04.000Z",
        payload: { reason: "Interrupted by user." },
      });
      await harness.drain();

      const completedThread = (await harness.readModel()).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(completedThread?.session).toMatchObject({
        status: hasPendingStart ? "starting" : "ready",
        activeTurnId: null,
      });
      expect(completedThread?.latestTurn).toMatchObject({ turnId: nextTurnId, state: "completed" });
    }

    harness.emit({
      ...base,
      type: "turn.started",
      eventId: asEventId("opencode-pending-started"),
      turnId: asTurnId("opencode-pending-turn"),
      createdAt: "2026-01-01T00:00:05.000Z",
    });
    await harness.drain();
    const startedThread = (await harness.readModel()).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(startedThread?.latestTurn).toMatchObject({
      turnId: asTurnId("opencode-pending-turn"),
      state: "running",
      requestedAt: pendingAt,
    });
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("clears active turn when provider session becomes ready", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-ready"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-session-ready",
      10_000,
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready-with-active-turn"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        state: "ready",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
      10_000,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.activeTurnId).toBeNull();
    expect(thread.session?.lastError).toBeNull();
  });

  effectIt.effect(
    "keeps a reconnecting pending turn starting while ready clears stale active state",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = asThreadId("thread-1");
        const staleTurnId = asTurnId("turn-stale-before-reconnect");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-pending-reconnect"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-reconnect"),
            role: "user",
            text: "resume after reconnect",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-starting-pending-reconnect"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: staleTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        });

        harness.emit({
          type: "session.state.changed",
          eventId: asEventId("evt-session-ready-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: { state: "ready" },
        });

        let thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) => entry.session?.status === "starting" && entry.session.activeTurnId === null,
          ),
        );
        expect(thread.session?.status).toBe("starting");
        expect(thread.session?.activeTurnId).toBeNull();

        harness.emit({
          type: "session.started",
          eventId: asEventId("evt-session-started-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.session?.status).toBe("starting");
        expect(thread.session?.activeTurnId).toBeNull();

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: asTurnId("turn-after-reconnect"),
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) =>
              entry.session?.status === "running" &&
              entry.session.activeTurnId === asTurnId("turn-after-reconnect"),
          ),
        );
        expect(thread.session?.status).toBe("running");

        harness.emit({
          type: "session.started",
          eventId: asEventId("evt-session-started-duplicate-midturn"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.session?.status).toBe("running");
        expect(thread.session?.activeTurnId).toBe(asTurnId("turn-after-reconnect"));
      }),
  );

  effectIt.effect("keeps a restarted in-flight turn running across a synthetic session start", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = asThreadId("thread-1");
      const delegatedMessageId = MessageId.make("delegated-message-before-restart");
      const interruptedTurnId = asTurnId("delegated-turn-before-restart");

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-restart"),
        threadId,
        message: {
          messageId: delegatedMessageId,
          role: "user",
          text: "delegated work",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-before-restart"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: interruptedTurnId,
        payload: { model: "gpt-5-codex" },
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* Effect.promise(() =>
        waitForThread(
          harness.readModel,
          (entry) =>
            entry.session?.status === "running" && entry.session.activeTurnId === interruptedTurnId,
        ),
      );

      // Startup reconciliation marks the interrupted session "starting" with
      // no active turn and forwards the interrupted turn under the
      // continuation marker (serverRuntimeStartup.ts).
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-starting-before-restart"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      });

      // The re-attaching adapter synthesizes session.started before the
      // continuation prompt opens its provider turn.
      harness.emit({
        type: "session.started",
        eventId: asEventId("evt-session-started-before-restart"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(thread.session?.status).toBe("starting");
      expect(thread.session?.activeTurnId).toBeNull();

      const turn = yield* Effect.promise(() =>
        harness.readLatestTurnById(threadId, interruptedTurnId),
      );
      expect(Option.isNone(turn)).toBe(false);
      expect(Option.getOrThrow(turn).state).toBe("running");
      expect(Option.getOrThrow(turn).pendingMessageId).toBe(delegatedMessageId);
    }),
  );

  effectIt.effect("keeps an aborted pending start stopped across duplicate exit events", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = asThreadId("thread-1");
      const stoppedAt = "2026-01-01T00:00:02.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-stop"),
        threadId,
        message: {
          messageId: MessageId.make("message-before-stop"),
          role: "user",
          text: "stop this startup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-starting-before-stop"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-stop-pending-start"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: stoppedAt,
        },
        createdAt: stoppedAt,
      });

      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-duplicate-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      yield* Effect.promise(() => harness.drain());
      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.activeTurnId).toBeNull();
    }),
  );

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
      10_000,
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      10_000,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("rejects an untargeted turn.completed when no turn is active", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    // A turn start is pending: the session reads "starting" with no active
    // turn tracked yet. This is the window the Claude resume handshake's
    // phantom (turn.completed with no turnId) used to slip through, stomping
    // "starting" back to "ready" for a turn that never existed.
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed-untargeted-completion"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "starting",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: seededAt,
        lastError: null,
      },
      createdAt: seededAt,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-untargeted"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("accepts a targeted turn.completed when no turn is active", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    // A completion that names its turn still lands even when no active turn
    // is tracked (e.g. its turn.started was lost). Only untargeted
    // completions are rejected.
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed-targeted-completion"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "starting",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: seededAt,
        lastError: null,
      },
      createdAt: seededAt,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-targeted-late"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late"),
      status: "completed",
    });

    await waitForThread(harness.readModel, (thread) => thread.session?.status === "ready");
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores provider content deltas that cannot change thread state", async () => {
    const harness = await createHarness();
    const initial = await harness.readModel();

    for (const streamKind of ["reasoning_text", "command_output", "file_change_output"] as const) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-ignored-${streamKind}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-ignored"),
        payload: {
          streamKind,
          delta: "ignored output",
        },
      });
    }

    await harness.drain();
    expect(await harness.readModel()).toEqual(initial);
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("preserves completed tool metadata on projected tool activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-completed-with-data"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-completed"),
      itemId: asItemId("item-tool-completed"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        data: {
          toolCallId: "tool-read-1",
          kind: "read",
          rawOutput: {
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-completed-with-data",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-with-data",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("tool.completed");
    expect(activity?.summary).toBe("Read file");
    expect(payload?.itemType).toBe("dynamic_tool_call");
    expect(payload?.detail).toBeUndefined();
    expect(data?.toolCallId).toBe("tool-read-1");
    expect(data?.kind).toBe("read");
    expect(rawOutput?.content).toBe('import * as Effect from "effect/Effect"\n');
  });

  it("normalizes command execution activities to ran-command summaries", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-completed"),
      itemId: asItemId("item-command-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun run lint",
        data: {
          toolCallId: "tool-command-1",
          kind: "execute",
          command: "bun run lint",
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Ran command");
    expect(payload?.detail).toBe("bun run lint");
  });

  it("uses structured read-file paths when available", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-read-path-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-read-path"),
      itemId: asItemId("item-read-path"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        detail: "/tmp/app.ts",
        data: {
          toolCallId: "tool-read-path-1",
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-read-path-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-read-path-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Read file");
    expect(payload?.detail).toBe("/tmp/app.ts");
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
    const implementedPlan = sourceThreadAfterStart.proposedPlans.find(
      (entry) => entry.id === sourcePlan.id,
    );
    await harness.emitAndDrain([
      {
        type: "turn.proposed.completed",
        eventId: asEventId("evt-plan-source-late-completion"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:01:00.000Z",
        threadId: sourceThreadId,
        turnId: sourceTurnId,
        payload: { planMarkdown: "# Source plan with late details" },
      },
    ]);
    const sourceAfterLateCompletion = (await harness.readModel()).threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceAfterLateCompletion?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      planMarkdown: "# Source plan with late details",
      createdAt: sourcePlan.createdAt,
      implementedAt: implementedPlan?.implementedAt,
      implementationThreadId: targetThreadId,
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      Effect.andThen(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-plan-source-guarded"),
          threadId: sourceThreadId,
          projectId: asProjectId("project-1"),
          title: "Plan Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-plan-source-guarded"),
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        }),
      ),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("accepts a conflicting turn.started for a pending turn start when the provider expects that turn", async () => {
    // Steering a running turn: the server requests a new turn while the old
    // one is still active, and providers like opencode open the new turn
    // without ever completing the superseded one. The new turn.started must
    // replace the active turn instead of being rejected as stale.
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const oldTurnId = asTurnId("turn-steered-over");
    const newTurnId = asTurnId("turn-from-steer");
    const createdAt = "2026-01-01T00:00:00.000Z";

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: oldTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-steered-over"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: oldTurnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === oldTurnId,
      2_000,
      threadId,
    );

    // The steer: a user-requested turn start while the old turn still runs.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-steer"),
        threadId,
        message: {
          messageId: asMessageId("msg-steer"),
          role: "user",
          text: "actually, do 15 instead",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    // The provider session tracks the new turn before emitting turn.started
    // (sendTurn updates the session first).
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: newTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-from-steer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: newTurnId,
    });

    const threadAfterSteer = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === newTurnId,
      2_000,
      threadId,
    );
    expect(threadAfterSteer.session?.activeTurnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.turnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.state).toBe("running");
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
    expect(proposedPlan?.createdAt).toBe(now);
  });

  it("releases a blank completed plan before a late replacement", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("blank-plan-turn");
    const base = { provider: ProviderDriverKind.make("codex"), threadId, turnId };
    const replacementTime = "2026-01-01T00:00:02.000Z";
    await harness.emitAndDrain([
      {
        ...base,
        type: "turn.proposed.delta",
        eventId: asEventId("blank-plan-delta"),
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { delta: " \n " },
      },
      {
        ...base,
        type: "turn.completed",
        eventId: asEventId("blank-plan-completed"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { state: "completed" },
      },
      {
        ...base,
        type: "turn.proposed.completed",
        eventId: asEventId("late-plan-completed"),
        createdAt: replacementTime,
        payload: { planMarkdown: "# Replacement plan" },
      },
    ]);
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.proposedPlans).toEqual([
      expect.objectContaining({ planMarkdown: "# Replacement plan", createdAt: replacementTime }),
    ]);
  });

  it("buffers assistant deltas with one lifecycle query per event until completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("evt-turn-started-buffered"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered"),
      },
    ]);

    const eventCount = 1_000;
    const before = harness.sqlCount();
    await harness.emitAndDrain(
      Array.from({ length: eventCount }, (_, index) => ({
        type: "content.delta",
        eventId: asEventId(`evt-message-delta-buffered-${index}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered"),
        itemId: asItemId("item-buffered"),
        payload: {
          streamKind: "assistant_text",
          delta: "a",
        },
      })),
    );
    expect(harness.sqlCount() - before).toBe(eventCount);

    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    await harness.emitAndDrain([
      {
        type: "item.completed",
        eventId: asEventId("evt-message-completed-buffered"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered"),
        itemId: asItemId("item-buffered"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      },
    ]);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    const message = thread?.messages.find((entry) => entry.id === "assistant:item-buffered");
    expect(message?.text).toBe("a".repeat(eventCount));
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when an approval request opens", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      itemId: asItemId("item-buffered-request-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      requestId: ApprovalRequestId.make("req-buffered-request-flush"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-flush" &&
          !message.streaming &&
          message.text === "visible before approval",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when user input is requested", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-user-input-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      itemId: asItemId("item-buffered-user-input-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before user input",
      },
    });
    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      requestId: ApprovalRequestId.make("req-buffered-user-input-flush"),
      payload: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Pick one",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-user-input-flush" &&
          !message.streaming &&
          message.text === "visible before user input",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-user-input-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  function userInputEvent(
    turnId: string,
    requestId: string,
    responseMode?: "message",
  ): ProviderRuntimeEvent {
    return {
      type: "user-input.requested",
      eventId: asEventId(`requested:${requestId}`),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId(turnId),
      requestId: RuntimeRequestId.make(requestId),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        ...(responseMode ? { responseMode } : {}),
        questions: ["first", "second"].map((id) => ({
          id,
          header: id,
          question: `Choose ${id}`,
          options: [{ label: "yes", description: "Continue" }],
          multiSelect: false,
        })),
      },
    };
  }

  it.each(["completed", "interrupted", "failed", "aborted"] as const)(
    "resolves native questions when their turn is %s",
    async (state) => {
      const harness = await createHarness();
      const request = userInputEvent("question-turn", "question-request");
      await harness.emitAndDrain([
        {
          type: "turn.started",
          eventId: asEventId("question-started"),
          provider: request.provider,
          threadId: request.threadId,
          turnId: request.turnId,
          createdAt: request.createdAt,
        },
        request,
      ]);
      expect((await harness.readThreadShell()).hasPendingUserInput).toBe(true);
      if (state === "interrupted") {
        await harness.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("question-interrupt"),
          threadId: request.threadId,
          createdAt: "2026-01-01T00:00:02.000Z",
        });
      }
      const completed: ProviderRuntimeEvent = {
        ...(state === "aborted"
          ? ({ type: "turn.aborted", payload: { reason: "Interrupted by user." } } as const)
          : ({ type: "turn.completed", payload: { state } } as const)),
        eventId: asEventId("question-completed"),
        provider: request.provider,
        threadId: request.threadId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      };
      await harness.emitAndDrain([completed]);
      const thread = (await harness.readModel()).threads[0]!;
      expect(thread.session?.activeTurnId).toBeNull();
      expect((await harness.readThreadShell()).hasPendingUserInput).toBe(false);
      expect(
        thread.activities.filter((activity) => activity.kind === "user-input.resolved"),
      ).toMatchObject([{ turnId: request.turnId, payload: { requestId: request.requestId } }]);

      await harness.emitAndDrain([completed]);
      expect(
        (await harness.readModel()).threads[0]!.activities.filter(
          (activity) => activity.kind === "user-input.resolved",
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps a stale request dismissed when its turn later completes", async () => {
    const harness = await createHarness();
    const request = userInputEvent("stale-turn", "stale-question");
    await harness.emitAndDrain([request]);
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("stale-question-response"),
      threadId: request.threadId,
      activity: {
        id: asEventId("stale-question-failed"),
        kind: "provider.user-input.respond.failed",
        tone: "error",
        summary: "User input response failed",
        turnId: request.turnId ?? null,
        payload: {
          requestId: request.requestId,
          detail: "Unknown pending user input request",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(false);
    await harness.emitAndDrain([
      {
        type: "turn.completed",
        eventId: asEventId("stale-turn-completed"),
        provider: request.provider,
        threadId: request.threadId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
        payload: { state: "completed" },
      },
    ]);
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(false);
    expect(
      (await harness.readModel()).threads[0]!.activities.filter(
        (activity) => activity.kind === "user-input.resolved",
      ),
    ).toMatchObject([{ payload: { requestId: request.requestId } }]);
  });

  it("preserves answered questions and leaves newer, child and async questions pending", async () => {
    const harness = await createHarness();
    const answered = userInputEvent("old-turn", "answered-question");
    const unresolved = userInputEvent("old-turn", "old-question");
    const newer = userInputEvent("new-turn", "new-question");
    const child = userInputEvent("child-turn", "child-question");
    const asynchronous = userInputEvent("old-turn", "async-question", "message");
    const answer: ProviderRuntimeEvent = {
      type: "user-input.resolved",
      eventId: asEventId("normal-answer"),
      provider: answered.provider,
      threadId: answered.threadId,
      turnId: answered.turnId,
      requestId: answered.requestId,
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { answers: { first: "yes", second: "yes" } },
    };
    await harness.emitAndDrain([
      answered,
      unresolved,
      newer,
      child,
      asynchronous,
      answer,
      {
        type: "turn.started",
        eventId: asEventId("new-turn-started"),
        provider: newer.provider,
        threadId: newer.threadId,
        turnId: newer.turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(true);
    await harness.emitAndDrain([
      {
        type: "turn.completed",
        eventId: asEventId("old-turn-completed"),
        provider: answered.provider,
        threadId: answered.threadId,
        turnId: answered.turnId,
        createdAt: "2026-01-01T00:00:04.000Z",
        payload: { state: "interrupted" },
      },
    ]);
    const thread = (await harness.readModel()).threads[0]!;
    expect(thread.session?.activeTurnId).toBe(newer.turnId);
    expect((await harness.readThreadShell()).hasPendingUserInput).toBe(true);
    expect(
      thread.activities.filter((activity) => activity.kind === "user-input.resolved"),
    ).toMatchObject([
      {
        id: answer.eventId,
        payload: { requestId: answered.requestId, answers: answer.payload.answers },
      },
      { turnId: unresolved.turnId, payload: { requestId: unresolved.requestId } },
    ]);
  });

  it("keeps streaming while an async question is pending", async () => {
    const harness = await createHarness({ serverSettings: { responseStreamingMode: "token" } });
    const base = {
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-async"),
    };
    harness.emit({ ...base, type: "turn.started", eventId: asEventId("async-start") });
    harness.emit({
      ...base,
      type: "content.delta",
      eventId: asEventId("async-before"),
      itemId: asItemId("message-1"),
      payload: { streamKind: "assistant_text", delta: "Before. " },
    });
    harness.emit({
      ...base,
      type: "user-input.requested",
      eventId: asEventId("async-request"),
      requestId: ApprovalRequestId.make("codex-async:question-1"),
      payload: {
        responseMode: "message",
        questions: [
          {
            id: "0",
            header: "Question",
            question: "Which name?",
            options: [],
            allowCustomAnswer: true,
          },
        ],
      },
    });
    harness.emit({
      ...base,
      type: "content.delta",
      eventId: asEventId("async-after"),
      itemId: asItemId("message-1"),
      payload: { streamKind: "assistant_text", delta: "After." },
    });
    await harness.drain();
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.session?.status).toBe("running");
    expect(thread?.messages).toMatchObject([{ text: "Before. After.", streaming: true }]);
    expect(
      thread?.activities.find((activity) => activity.kind === "user-input.requested")?.payload,
    ).toMatchObject({ responseMode: "message", requestId: "codex-async:question-1" });
  });

  it("does not create assistant segments for whitespace-only buffered text at approval boundaries", async () => {
    const harness = await createHarness();
    const startedAt = "2026-03-28T06:28:00.000Z";
    const pausedAt = "2026-03-28T06:28:01.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-whitespace-request",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      itemId: asItemId("item-buffered-whitespace-request"),
      payload: {
        streamKind: "assistant_text",
        delta: "\n\n\n",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      requestId: ApprovalRequestId.make("req-buffered-whitespace-request"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
      ),
    );
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace-request",
      ),
    ).toBe(false);
  });

  it("starts a new buffered assistant message segment after approval and completes without duplication", async () => {
    const harness = await createHarness();
    const startedAt = "2026-03-28T06:07:00.000Z";
    const pausedAt = "2026-03-28T06:07:01.000Z";
    const resumedAt = "2026-03-28T06:07:02.000Z";
    const completedAt = "2026-03-28T06:07:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-append",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: "first half",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      requestId: ApprovalRequestId.make("req-buffered-request-append"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append" &&
          !message.streaming &&
          message.text === "first half",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: " second half",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append:segment:1" &&
          !message.streaming &&
          message.text === " second half",
      ),
    );
    const firstMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-append",
    );
    const resumedMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-request-append:segment:1",
    );
    expect(firstMessage?.text).toBe("first half");
    expect(firstMessage?.streaming).toBe(false);
    expect(resumedMessage?.text).toBe(" second half");
    expect(resumedMessage?.streaming).toBe(false);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId.startsWith("assistant:item-buffered-request-append"),
    );
    expect(assistantEvents).toHaveLength(4);
    expect(assistantEvents[0]?.payload.streaming).toBe(true);
    expect(assistantEvents[0]?.payload.text).toBe("first half");
    expect(assistantEvents[1]?.payload.streaming).toBe(false);
    expect(assistantEvents[1]?.payload.text).toBe("");
    expect(assistantEvents[2]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[2]?.payload.streaming).toBe(true);
    expect(assistantEvents[2]?.payload.text).toBe(" second half");
    expect(assistantEvents[3]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[3]?.payload.streaming).toBe(false);
    expect(assistantEvents[3]?.payload.text).toBe("");
  });

  it("starts a new streaming assistant message segment after approval", async () => {
    const harness = await createHarness({ serverSettings: { responseStreamingMode: "token" } });
    const startedAt = "2026-03-28T07:00:00.000Z";
    const pausedAt = "2026-03-28T07:00:01.000Z";
    const resumedAt = "2026-03-28T07:00:02.000Z";
    const completedAt = "2026-03-28T07:00:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-request-segment",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: "before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      requestId: ApprovalRequestId.make("req-streaming-request-segment"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment" &&
          !message.streaming &&
          message.text === "before approval",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: " after approval",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1" &&
          !message.streaming &&
          message.text === " after approval",
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment",
      )?.text,
    ).toBe("before approval");
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1",
      )?.text,
    ).toBe(" after approval");
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { responseStreamingMode: "token" } });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("delivers finished paragraphs while the rest of the message stays buffered", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const codex = ProviderDriverKind.make("codex");
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-paragraph-flush");
    const itemId = asItemId("item-paragraph-flush");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-paragraph-started"),
      provider: codex,
      createdAt: now,
      threadId,
      turnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === turnId,
    );

    // Each delta lands well outside the pacing window of the one before.
    const emitDelta = (eventId: string, delta: string) => {
      harness.advanceClock(1_000);
      harness.emit({
        type: "content.delta",
        eventId: asEventId(eventId),
        provider: codex,
        createdAt: now,
        threadId,
        turnId,
        itemId,
        payload: { streamKind: "assistant_text", delta },
      });
    };

    emitDelta("evt-paragraph-1", "First paragraph.\n\nSecond para");
    const afterFirst = await waitForThread(harness.readModel, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === `assistant:${itemId}`,
      ),
    );
    expect(
      afterFirst.messages.find((m: ProviderRuntimeTestMessage) => m.id === `assistant:${itemId}`),
    ).toMatchObject({
      text: "First paragraph.\n\n",
      streaming: true,
    });

    // An open code block holds the whole block until its closing fence lands.
    emitDelta("evt-paragraph-2", "graph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n");
    await harness.drain();
    expect(
      (await harness.readModel()).threads
        .find((t) => t.id === threadId)
        ?.messages.find((m: ProviderRuntimeTestMessage) => m.id === `assistant:${itemId}`)?.text,
    ).toBe("First paragraph.\n\nSecond paragraph.\n\n");

    emitDelta("evt-paragraph-3", "```\n\nTail without newline");
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-paragraph-completed"),
      provider: codex,
      createdAt: now,
      threadId,
      turnId,
      itemId,
      payload: { itemType: "assistant_message", status: "completed" },
    });
    const finalThread = await waitForThread(harness.readModel, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === `assistant:${itemId}` && !message.streaming,
      ),
    );
    expect(
      finalThread.messages.find((m: ProviderRuntimeTestMessage) => m.id === `assistant:${itemId}`)
        ?.text,
    ).toBe(
      "First paragraph.\n\nSecond paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nTail without newline",
    );
  });

  it("holds every paragraph until completion in turn mode", async () => {
    const harness = await createHarness({ serverSettings: { responseStreamingMode: "turn" } });
    const now = "2026-01-01T00:00:00.000Z";
    const codex = ProviderDriverKind.make("codex");
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-wait-mode");
    const itemId = asItemId("item-wait-mode");

    await harness.emitAndDrain([
      {
        type: "turn.started",
        eventId: asEventId("evt-wait-started"),
        provider: codex,
        createdAt: now,
        threadId,
        turnId,
      },
    ]);
    harness.advanceClock(1_000);
    await harness.emitAndDrain([
      {
        type: "content.delta",
        eventId: asEventId("evt-wait-delta"),
        provider: codex,
        createdAt: now,
        threadId,
        turnId,
        itemId,
        payload: {
          streamKind: "assistant_text",
          delta: "First paragraph.\n\nSecond paragraph.\n\n",
        },
      },
    ]);
    const messageText = async () =>
      (await harness.readModel()).threads
        .find((t) => t.id === threadId)
        ?.messages.find((m: ProviderRuntimeTestMessage) => m.id === `assistant:${itemId}`)?.text;
    // Paragraph mode would have delivered both paragraphs by now.
    expect(await messageText()).toBeUndefined();

    await harness.emitAndDrain([
      {
        type: "item.completed",
        eventId: asEventId("evt-wait-completed"),
        provider: codex,
        createdAt: now,
        threadId,
        turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);
    expect(await messageText()).toBe("First paragraph.\n\nSecond paragraph.\n\n");
  });

  it("holds paragraphs that finish inside the pacing window and lands them together", async () => {
    const harness = await createHarness();
    const codex = ProviderDriverKind.make("codex");
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-paced");
    const itemId = asItemId("item-paced");
    // Every delta carries the same event time, like OpenCode does for one
    // part. Pacing must follow the server clock, not the event stamp.
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-paced-started"),
      provider: codex,
      createdAt: now,
      threadId,
      turnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === turnId,
    );
    // Emit is fire-and-forget, so drain after each delta before moving the
    // clock. Otherwise the worker reads a clock that has already advanced.
    let clockMs = 0;
    const emitDelta = async (eventId: string, delta: string, offsetMs: number) => {
      harness.advanceClock(offsetMs - clockMs);
      clockMs = offsetMs;
      await harness.emitAndDrain([
        {
          type: "content.delta",
          eventId: asEventId(eventId),
          provider: codex,
          createdAt: now,
          threadId,
          turnId,
          itemId,
          payload: { streamKind: "assistant_text", delta },
        },
      ]);
    };
    const messageText = async () =>
      (await harness.readModel()).threads
        .find((t) => t.id === threadId)
        ?.messages.find((m: ProviderRuntimeTestMessage) => m.id === `assistant:${itemId}`)?.text;

    await emitDelta("evt-paced-1", "One.\n\n", 0);
    await emitDelta("evt-paced-2", "Two.\n\n", 100);
    await emitDelta("evt-paced-3", "Three.\n\n", 200);
    // The first paragraph lands right away. The next two are inside the window.
    expect(await messageText()).toBe("One.\n\n");

    await emitDelta("evt-paced-4", "Four.\n\n", 500);
    expect(await messageText()).toBe("One.\n\nTwo.\n\nThree.\n\nFour.\n\n");
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      itemId: asItemId("tool-call-9"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command run",
        toolSurface: "computer",
        toolIcon: {
          _tag: "native-app",
          app: { _tag: "app-id", appId: "com.apple.Terminal" },
        },
        toolSource: {
          key: "native-app:com.apple.terminal",
          name: "Terminal",
          kind: "computer",
        },
        detail: "Bash: vp test run",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.kind === "tool.started",
    );
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      itemType: "command_execution",
      toolCallId: "tool-call-9",
      status: "inProgress",
      title: "Command run",
      toolSurface: "computer",
      toolIcon: {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.apple.Terminal" },
      },
      toolSource: {
        key: "native-app:com.apple.terminal",
        name: "Terminal",
        kind: "computer",
      },
      detail: "Bash: vp test run",
      data: {
        toolName: "Bash",
        input: { command: "vp test run" },
      },
    });
  });

  effectIt.effect("tracks provider diff updates from a nested Git workspace", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ workspaceSubdirectory: "apps/server" }),
      );
      yield* Effect.promise(() =>
        harness.emitAndDrain([
          {
            type: "turn.diff.updated",
            eventId: asEventId("evt-nested-diff"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-01-01T00:00:00.000Z",
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("nested-turn"),
            payload: {
              unifiedDiff: "diff --git a/apps/server/file.ts b/apps/server/file.ts\n+new\n",
            },
          },
        ]),
      );
      const snapshot = yield* Effect.promise(harness.readModel);
      expect(snapshot.threads[0]?.checkpoints).toEqual([
        expect.objectContaining({ turnId: "nested-turn", status: "missing" }),
      ]);
    }),
  );

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.title === "Thread" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Thread");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");
    expect(toolUpdatePayload?.toolCallId).toBe("item-p1-tool");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("mirrors a provider title only while the thread still has the default title", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_THREAD_TITLE });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-default"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.title === "Renamed by provider",
    );
    expect(thread.title).toBe("Renamed by provider");
  });

  it("rejects a provider title once the thread has a real title", async () => {
    const harness = await createHarness({ threadTitle: "User-set title" });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-real"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("User-set title");
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    const compactCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-thread-compact"),
      threadId: asThreadId("thread-1"),
      message: {
        messageId: asMessageId("message-compact"),
        role: "user",
        text: "/compact",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    } satisfies OrchestrationCommand;
    await harness.dispatch(compactCommand);
    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-starting-compact"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: { state: "starting" },
    });
    await waitForThread(harness.readModel, (entry) => entry.session?.status === "starting");

    for (const [index, usedTokens] of [899_000, 0].entries()) {
      harness.emit({
        type: "thread.token-usage.updated",
        eventId: asEventId(`evt-thread-token-usage-${index}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        payload: { usage: { usedTokens } },
      });
    }
    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.filter(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
        ).length === 2,
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-thread-compacted",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-thread-compacted",
    );
    expect(activity?.summary).toBe("Compacted context 899K → 0 tokens");
    expect(activity?.tone).toBe("info");
    expect(activity?.payload).toMatchObject({ requestId: "message-compact" });
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.id === "task-progress:thread-1:turn-task-1",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("titles task activities with the task description, including on completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-named-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        description: "Typecheck mobile app",
        taskType: "local_bash",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-named-task-progress"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        description: "Typecheck mobile app",
        summary: "Running tsc across the mobile workspace.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-named-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        status: "completed",
        summary: "Typecheck finished without errors.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.id === "task-progress:thread-1:named-task-1",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(progress?.summary).toBe("Typecheck mobile app");
    expect(progressPayload?.title).toBe("Typecheck mobile app");
    expect(completed?.summary).toBe("Task completed");
    expect(completedPayload?.title).toBe("Typecheck mobile app");
    expect(completedPayload?.summary).toBe("Typecheck finished without errors.");
    expect(completedPayload?.detail).toBe("Typecheck finished without errors.");
  });

  it("titles task completion from task.started when no progress event carried the name", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-fast-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fast-task"),
      payload: {
        taskId: "fast-task-1",
        description: "wait for codex review to finish",
        taskType: "local_bash",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-fast-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fast-task"),
      payload: {
        taskId: "fast-task-1",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(completedPayload?.title).toBe("wait for codex review to finish");
  });

  it("recovers a task title past untitled progress after the cache is swept", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-swept-task");
    const provider = ProviderDriverKind.make("claudeAgent");

    await harness.emitAndDrain([
      {
        type: "task.started",
        eventId: asEventId("evt-swept-task-started"),
        provider,
        createdAt: now,
        threadId,
        turnId,
        payload: { taskId: "swept-task-1", description: "Watch round-3 CI and bots" },
      },
    ]);
    // Older saved progress rows can have no title even when the start has one.
    await harness.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-swept-task-progress"),
      threadId,
      activity: {
        id: asEventId("evt-swept-task-progress"),
        kind: "task.progress",
        tone: "info",
        summary: "Polling CI checks.",
        payload: { taskId: "swept-task-1" },
        turnId,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.emitAndDrain([
      {
        type: "session.exited",
        eventId: asEventId("evt-swept-task-session-exited"),
        provider,
        createdAt: "2026-01-01T00:00:02.000Z",
        threadId,
        payload: {},
      },
      {
        type: "task.completed",
        eventId: asEventId("evt-swept-task-completed"),
        provider,
        createdAt: "2026-01-01T00:00:03.000Z",
        threadId,
        turnId,
        payload: { taskId: "swept-task-1", status: "completed", summary: "CI is green." },
      },
    ]);

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    const completed = thread?.activities.find(
      (activity) => activity.id === "evt-swept-task-completed",
    );
    expect(completed?.payload).toMatchObject({ title: "Watch round-3 CI and bots" });
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});

describe("splitBufferedAssistantText", () => {
  it("keeps a partial trailing line buffered", () => {
    expect(splitBufferedAssistantText("one\n\ntwo")).toEqual({ ready: "one\n\n", rest: "two" });
    expect(splitBufferedAssistantText("one\ntwo")).toEqual({ ready: "", rest: "one\ntwo" });
  });

  it("does not split inside an open fence and delivers the block at its closing fence", () => {
    const open = "intro\n\n```\ncode\n\nmore\n";
    expect(splitBufferedAssistantText(open)).toEqual({
      ready: "intro\n\n",
      rest: "```\ncode\n\nmore\n",
    });
    expect(splitBufferedAssistantText(`${open}\`\`\`\nafter`)).toEqual({
      ready: `${open}\`\`\`\n`,
      rest: "after",
    });
  });

  it("does not treat a fence with an info string as a closing fence", () => {
    const text = "```\n```javascript\nstill code\n\nmore\n";
    expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
  });

  it("treats a fence indented four or more spaces as code, not a closing fence", () => {
    const text = "```\n    ```\n\nstill code\n";
    expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
    expect(splitBufferedAssistantText("```\n   ```\nafter")).toEqual({
      ready: "```\n   ```\n",
      rest: "after",
    });
  });

  it("keeps a fence nested under a list item open across its blank lines", () => {
    const text = "- step\n\n    ```ts\n    a\n\n    b\n    ```\n\nafter\n";
    expect(splitBufferedAssistantText(text)).toEqual({
      ready: "- step\n\n    ```ts\n    a\n\n    b\n    ```\n\n",
      rest: "after\n",
    });
  });

  it("does not treat a no-break-space line as blank", () => {
    expect(splitBufferedAssistantText("para\n\u00a0\ncont\n\nnext")).toEqual({
      ready: "para\n\u00a0\ncont\n\n",
      rest: "next",
    });
  });

  it("treats CRLF blank lines as boundaries", () => {
    expect(splitBufferedAssistantText("one\r\n\r\ntwo")).toEqual({
      ready: "one\r\n\r\n",
      rest: "two",
    });
  });

  it("only closes a fence with the same marker of equal or greater length", () => {
    const text = "````\n```\nstill code\n\n````\n\nout\n";
    expect(splitBufferedAssistantText(text)).toEqual({
      ready: "````\n```\nstill code\n\n````\n\n",
      rest: "out\n",
    });
    expect(splitBufferedAssistantText("~~~\n```\n\nx\n")).toEqual({
      ready: "",
      rest: "~~~\n```\n\nx\n",
    });
  });

  it("delivers tight list items one at a time", () => {
    expect(splitBufferedAssistantText("## Steps\n\n- one\n- two\n- thr")).toEqual({
      ready: "## Steps\n\n- one\n- two\n",
      rest: "- thr",
    });
    expect(splitBufferedAssistantText("1. one\n2. two\n   more\n3. t")).toEqual({
      ready: "1. one\n2. two\n   more\n",
      rest: "3. t",
    });
  });

  it("keeps a partial list marker and list-like code buffered", () => {
    expect(splitBufferedAssistantText("intro\n-")).toEqual({ ready: "", rest: "intro\n-" });
    expect(splitBufferedAssistantText("intro\n1.")).toEqual({ ready: "", rest: "intro\n1." });
    // `intro\n- \n` would parse as a setext heading, so a bare marker with only
    // trailing whitespace is not a boundary on the partial line either.
    expect(splitBufferedAssistantText("intro\n- ")).toEqual({ ready: "", rest: "intro\n- " });
    expect(splitBufferedAssistantText("- one\n")).toEqual({ ready: "", rest: "- one\n" });
    expect(splitBufferedAssistantText("```\n- one\n- two\n")).toEqual({
      ready: "",
      rest: "```\n- one\n- two\n",
    });
  });
});
