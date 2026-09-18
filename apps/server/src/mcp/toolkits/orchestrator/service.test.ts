import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointRef,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestratorMcpDelegateTaskInput,
  type ProviderInstanceConfig,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { normalizeDelegationPermissionEnvelope } from "../../../provider/DelegationPermissionEnvelope.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  __testing,
  type OrchestratorMcpDependencies,
  type OrchestratorMcpServiceShape,
} from "./service.ts";

const now = "2026-09-14T10:00:00.000Z";
const parentThreadId = ThreadId.make("parent-thread");
const parentTurnId = TurnId.make("parent-turn");
const projectId = ProjectId.make("project-one");
const environmentId = EnvironmentId.make("environment-one");
const providerInstanceId = ProviderInstanceId.make("codex_one");
const legacyProviderInstanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("codex");
const workspaceRoot = "C:/repo";

const instanceConfig: ProviderInstanceConfig = {
  driver: driverKind,
  enabled: true,
  config: { binaryPath: "codex", launchArgs: "" },
};

const legacyCodexSettings = {
  ...DEFAULT_SERVER_SETTINGS.providers.codex,
  binaryPath: "codex",
  launchArgs: "",
};

const legacyInstanceConfig: ProviderInstanceConfig = {
  driver: driverKind,
  config: legacyCodexSettings,
};

const provider = {
  instanceId: providerInstanceId,
  driver: driverKind,
  displayName: "Codex work",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  availability: "available",
  version: "1.0.0",
  checkedAt: now,
  models: [
    {
      slug: "gpt-test",
      name: "GPT Test",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
} as ServerProvider;

const legacyProvider = {
  ...provider,
  instanceId: legacyProviderInstanceId,
} as ServerProvider;

function parentShell(): OrchestrationThreadShell {
  return {
    id: parentThreadId,
    projectId,
    title: "Parent",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId: parentTurnId,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: parentThreadId,
      status: "running",
      providerName: "codex",
      providerInstanceId,
      runtimeMode: "full-access",
      activeTurnId: parentTurnId,
      lastError: null,
      updatedAt: now,
    },
  } as OrchestrationThreadShell;
}

const project = {
  id: projectId,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
} as OrchestrationProjectShell;

function makeScope(
  runtimeMode: RuntimeMode = "full-access",
  targetInstanceConfig: ProviderInstanceConfig = instanceConfig,
): McpInvocationScope {
  const capabilities = new Set(["pull-requests", "orchestration"] as const);
  const permissionEnvelope = normalizeDelegationPermissionEnvelope({
    driverKind,
    runtimeMode,
    interactionMode: "default",
    instanceConfig: targetInstanceConfig,
    environment: {},
    workspaceRoot,
    worktreePath: workspaceRoot,
    branch: "main",
    t3McpCapabilities: capabilities,
    providerConfigurationFiles: [],
  });
  return {
    environmentId,
    threadId: parentThreadId,
    providerSessionId: "provider-session-one",
    providerInstanceId,
    capabilities,
    orchestration: {
      projectId,
      runtimeMode,
      interactionMode: "default",
      branch: "main",
      workspaceRoot,
      worktreePath: workspaceRoot,
      permissionEnvelope,
    },
    issuedAt: 1,
  };
}

const delegateInput = (overrides: Partial<OrchestratorMcpDelegateTaskInput> = {}) =>
  ({
    idempotencyKey: "implement-widget",
    title: "Implement widget",
    prompt: "Implement the accepted widget contract.",
    role: "implementation",
    target: {
      providerInstanceId,
      driverKind,
      model: "gpt-test",
      options: [{ id: "effort", value: "high" }],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...overrides,
  }) satisfies OrchestratorMcpDelegateTaskInput;

function emptyChild(
  command: Extract<OrchestrationCommand, { readonly type: "thread.create" }>,
): OrchestrationThread {
  return {
    id: command.threadId,
    projectId: command.projectId,
    title: command.title,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    branch: command.branch,
    worktreePath: command.worktreePath,
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    pullRequests: [],
    session: null,
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  } as OrchestrationThread;
}

function pendingTurn(threadId: ThreadId, messageId: MessageId): ProjectionTurn {
  return {
    threadId,
    turnId: null,
    pendingMessageId: messageId,
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: null,
    state: "pending",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
  };
}

interface HarnessOptions {
  readonly settingsSequence?: ReadonlyArray<ProviderInstanceConfig>;
  readonly useLegacyProviderConfig?: boolean;
  readonly parentRuntimeMode?: RuntimeMode;
  readonly interruptOutcomes?: ReadonlyArray<"failure" | "success">;
  readonly failAfterOnce?: "thread.create" | "thread.activity.append";
  readonly patchParentShell?: (shell: OrchestrationThreadShell) => OrchestrationThreadShell;
}

function makeHarness(options: HarnessOptions = {}): {
  readonly service: OrchestratorMcpServiceShape;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly children: Map<ThreadId, OrchestrationThread>;
  readonly turns: Map<ThreadId, Array<ProjectionTurn>>;
  readonly order: Array<string>;
} {
  const dispatched: Array<OrchestrationCommand> = [];
  const children = new Map<ThreadId, OrchestrationThread>();
  const turns = new Map<ThreadId, Array<ProjectionTurn>>();
  const order: Array<string> = [];
  let settingsRead = 0;
  let interruptAttempt = 0;
  let injectedDispatchFailure = false;

  const dependencies: OrchestratorMcpDependencies = {
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.create") {
          if (!children.has(command.threadId)) children.set(command.threadId, emptyChild(command));
        } else if (command.type === "thread.activity.append") {
          const child = children.get(command.threadId);
          if (
            child !== undefined &&
            !child.activities.some(({ id }) => id === command.activity.id)
          ) {
            children.set(command.threadId, {
              ...child,
              activities: [...child.activities, command.activity],
              updatedAt: command.createdAt,
            });
          }
        } else if (command.type === "thread.turn.start") {
          const child = children.get(command.threadId);
          if (child !== undefined) {
            children.set(command.threadId, {
              ...child,
              messages: [
                ...child.messages,
                {
                  id: command.message.messageId,
                  role: "user",
                  text: command.message.text,
                  turnId: null,
                  streaming: false,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
              ],
              updatedAt: command.createdAt,
            });
            turns.set(command.threadId, [pendingTurn(command.threadId, command.message.messageId)]);
          }
        } else if (command.type === "thread.turn.interrupt") {
          const child = children.get(command.threadId);
          const rows = turns.get(command.threadId) ?? [];
          const outcome =
            options.interruptOutcomes?.[
              Math.min(interruptAttempt, (options.interruptOutcomes?.length ?? 1) - 1)
            ] ?? "success";
          interruptAttempt += 1;
          if (outcome === "failure") {
            if (child !== undefined) {
              children.set(command.threadId, {
                ...child,
                activities: [
                  ...child.activities,
                  {
                    id: EventId.make(`interrupt-failed-${interruptAttempt}`),
                    tone: "error",
                    kind: "provider.turn.interrupt.failed",
                    summary: "Provider turn interrupt failed",
                    payload: { requestId: command.commandId, detail: "injected interrupt failure" },
                    turnId: command.turnId ?? null,
                    createdAt: command.createdAt,
                  },
                ],
              });
            }
            return { sequence: dispatched.length };
          }
          const target = rows.find(
            (row) => command.turnId === undefined || row.turnId === command.turnId,
          );
          if (target !== undefined) {
            Object.assign(target, { state: "interrupted", completedAt: command.createdAt });
          }
          if (child?.session !== null && child?.session !== undefined) {
            children.set(command.threadId, {
              ...child,
              session: { ...child.session, activeTurnId: null, status: "interrupted" },
              activities: [
                ...child.activities,
                {
                  id: EventId.make(`delegation-cancelled-${interruptAttempt}`),
                  tone: "info",
                  kind: "delegation.cancelled",
                  summary: "Delegated task cancelled",
                  payload: {
                    taskId: command.threadId,
                    delegatedMessageId:
                      command.pendingMessageId ?? target?.pendingMessageId ?? "unknown-message",
                    delegatedTurnId: target?.turnId ?? null,
                    reason: "provider-interrupted",
                  },
                  turnId: target?.turnId ?? null,
                  createdAt: command.createdAt,
                },
              ],
              updatedAt: command.createdAt,
            });
          } else if (child !== undefined) {
            children.set(command.threadId, {
              ...child,
              activities: [
                ...child.activities,
                {
                  id: EventId.make(`delegation-cancelled-${interruptAttempt}`),
                  tone: "info",
                  kind: "delegation.cancelled",
                  summary: "Delegated task cancelled",
                  payload: {
                    taskId: command.threadId,
                    delegatedMessageId:
                      command.pendingMessageId ?? target?.pendingMessageId ?? "unknown-message",
                    delegatedTurnId: target?.turnId ?? null,
                    reason: "start-suppressed",
                  },
                  turnId: target?.turnId ?? null,
                  createdAt: command.createdAt,
                },
              ],
              updatedAt: command.createdAt,
            });
          }
        }
        if (command.type === options.failAfterOnce && !injectedDispatchFailure) {
          injectedDispatchFailure = true;
          throw new Error(`injected failure after ${command.type}`);
        }
        return { sequence: dispatched.length };
      }),
    subscribeDomainEvents: Effect.sync(() => {
      order.push("subscribe");
      return Stream.empty;
    }),
    getThreadShellById: (threadId) => {
      const shell = parentShell();
      const runtimeMode = options.parentRuntimeMode ?? shell.runtimeMode;
      const patched =
        threadId === parentThreadId
          ? {
              ...shell,
              runtimeMode,
              session: shell.session === null ? null : { ...shell.session, runtimeMode },
            }
          : null;
      return Effect.succeed(
        patched === null
          ? Option.none()
          : Option.some(
              options.patchParentShell === undefined ? patched : options.patchParentShell(patched),
            ),
      );
    },
    getProjectShellById: (requestedProjectId) =>
      Effect.succeed(requestedProjectId === projectId ? Option.some(project) : Option.none()),
    getThreadDetailById: (threadId, query) =>
      Effect.sync(() => {
        order.push(`detail:${threadId}`);
        const child = children.get(threadId);
        if (child === undefined) return Option.none();
        return Option.some({
          ...child,
          activities:
            query?.activityKinds === undefined
              ? child.activities.slice(-500)
              : child.activities.filter((activity) => query.activityKinds?.includes(activity.kind)),
        });
      }),
    listTurnsByThreadId: ({ threadId }) => Effect.succeed(turns.get(threadId) ?? []),
    getProviders: Effect.succeed([options.useLegacyProviderConfig ? legacyProvider : provider]),
    getSettings: Effect.sync(() => {
      const sequence = options.settingsSequence ?? [instanceConfig];
      const selected = sequence[Math.min(settingsRead, sequence.length - 1)]!;
      settingsRead += 1;
      return {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: legacyCodexSettings,
        },
        providerInstances: options.useLegacyProviderConfig
          ? {}
          : { [providerInstanceId]: selected },
      } satisfies ServerSettings;
    }),
    loadPermissionEnvelope: (input) =>
      Effect.succeed(
        normalizeDelegationPermissionEnvelope({ ...input, providerConfigurationFiles: [] }),
      ),
    now: Effect.succeed(now),
  };
  return {
    service: __testing.makeService(dependencies),
    dispatched,
    children,
    turns,
    order,
  };
}

function bindDelegatedTurn(
  harness: ReturnType<typeof makeHarness>,
  taskId: ThreadId,
  messageId: MessageId,
  state: "running" | "completed" = "running",
): TurnId {
  const turnId = TurnId.make("delegated-turn");
  const row = pendingTurn(taskId, messageId);
  Object.assign(row, {
    turnId,
    state,
    startedAt: now,
    completedAt: state === "completed" ? now : null,
  });
  harness.turns.set(taskId, [row]);
  const child = harness.children.get(taskId)!;
  harness.children.set(taskId, {
    ...child,
    latestTurn: {
      turnId,
      state,
      requestedAt: now,
      startedAt: now,
      completedAt: state === "completed" ? now : null,
      assistantMessageId: null,
    },
    session: {
      threadId: taskId,
      status: state === "running" ? "running" : "ready",
      providerName: "codex",
      providerInstanceId,
      runtimeMode: child.runtimeMode,
      activeTurnId: state === "running" ? turnId : null,
      lastError: null,
      updatedAt: now,
    },
  });
  return turnId;
}

describe("OrchestratorMcpService", () => {
  it.effect("delegates through a legacy default provider configuration", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ useLegacyProviderConfig: true });
      const scope = makeScope("full-access", legacyInstanceConfig);

      const capabilities = yield* harness.service.capabilities(scope);
      expect(capabilities.providers).toHaveLength(1);
      expect(capabilities.providers[0]).toMatchObject({
        providerInstanceId: legacyProviderInstanceId,
        driverKind,
        delegatable: true,
        unavailableReason: null,
        permissionEnvelope: { status: "verified" },
      });

      const delegated = yield* harness.service.delegateTask(
        scope,
        delegateInput({
          target: {
            providerInstanceId: legacyProviderInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "high" }],
          },
        }),
      );
      expect(delegated.status).toBe("queued");
      expect(harness.dispatched.map(({ type }) => type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("tags every parent_not_active refusal with a distinct reason token", () =>
    Effect.gen(function* () {
      const scope = makeScope();
      const staleInstance = ProviderInstanceId.make("codex_stale");
      const cases = [
        {
          reason: "parent_no_active_turn",
          patch: (shell: OrchestrationThreadShell): OrchestrationThreadShell => ({
            ...shell,
            session: shell.session === null ? null : { ...shell.session, activeTurnId: null },
          }),
        },
        {
          reason: "parent_turn_mismatch",
          patch: (shell: OrchestrationThreadShell): OrchestrationThreadShell => ({
            ...shell,
            latestTurn:
              shell.latestTurn === null
                ? null
                : { ...shell.latestTurn, turnId: TurnId.make("newer-turn") },
          }),
        },
        {
          reason: "parent_turn_not_running",
          patch: (shell: OrchestrationThreadShell): OrchestrationThreadShell => ({
            ...shell,
            latestTurn:
              shell.latestTurn === null
                ? null
                : { ...shell.latestTurn, state: "completed" as const },
          }),
        },
        {
          reason: "parent_session_instance_changed",
          patch: (shell: OrchestrationThreadShell): OrchestrationThreadShell => ({
            ...shell,
            session:
              shell.session === null
                ? null
                : { ...shell.session, providerInstanceId: staleInstance },
          }),
        },
      ] as const;
      for (const { reason, patch } of cases) {
        const harness = makeHarness({ patchParentShell: patch });
        const refusal = yield* harness.service.capabilities(scope).pipe(Effect.flip);
        expect(refusal.code).toBe("parent_not_active");
        expect(refusal.message).toContain(`[reason=${reason}]`);
      }
    }),
  );

  it.effect("creates one inherited child, stores its handoff, and sends the exact prompt", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const handoff = {
        contractRef: "oc://doc/54218669-e04a-440e-96eb-f9117f918957",
        requiredRevision: 2,
        implementsRevision: 2,
        stage: "implementation",
        owns: ["server toolkit"],
        reads: ["accepted contract"],
        forbidden: ["provider adapters"],
        acceptance: ["focused tests pass"],
        outputs: ["child result"],
        evidence: ["test log"],
        predecessorRefs: ["oc://doc/1a02392b-6ad7-4d21-aae9-dfaa911c8831"],
      } as const;
      const result = yield* harness.service.delegateTask(makeScope(), delegateInput({ handoff }));

      expect(result.status).toBe("queued");
      expect(result.lineage.parentTurnId).toBe(parentTurnId);
      expect(result.lineage.delegatedTurnId).toBeNull();
      expect(harness.dispatched.map(({ type }) => type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
      ]);
      const create = harness.dispatched[0];
      expect(create).toMatchObject({
        type: "thread.create",
        projectId,
        branch: "main",
        worktreePath: null,
      });
      const start = harness.dispatched[2];
      expect(start?.type).toBe("thread.turn.start");
      if (start?.type === "thread.turn.start") {
        expect(start.message.text).toBe("Implement the accepted widget contract.");
        expect(start.message.text).not.toContain(handoff.contractRef);
      }
      const child = harness.children.get(result.taskId)!;
      const lineage = child.activities.find(({ kind }) => kind === "delegation.created");
      expect(lineage?.payload).toMatchObject({
        handoff,
        stage: handoff.stage,
        evidenceRefs: handoff.evidence,
        ocl: {
          contractRef: handoff.contractRef,
          requiredRevision: handoff.requiredRevision,
          implementsRevision: handoff.implementsRevision,
        },
      });
    }),
  );

  it.effect("deduplicates an exact retry and rejects changed input under the same key", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const first = yield* harness.service.delegateTask(scope, delegateInput());
      const second = yield* harness.service.delegateTask(scope, delegateInput());
      expect(second.taskId).toBe(first.taskId);
      expect(harness.dispatched.filter(({ type }) => type === "thread.create")).toHaveLength(1);
      expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(1);

      const conflict = yield* harness.service
        .delegateTask(scope, delegateInput({ prompt: "Different work under the same key." }))
        .pipe(Effect.flip);
      expect(conflict.code).toBe("idempotency_conflict");

      const handoffConflict = yield* harness.service
        .delegateTask(
          scope,
          delegateInput({
            handoff: {
              contractRef: "oc://doc/54218669-e04a-440e-96eb-f9117f918957",
              requiredRevision: 2,
              implementsRevision: 2,
              stage: "implementation",
              owns: [],
              reads: [],
              forbidden: [],
              acceptance: [],
              outputs: [],
              evidence: [],
              predecessorRefs: [],
            },
          }),
        )
        .pipe(Effect.flip);
      expect(handoffConflict.code).toBe("idempotency_conflict");
    }),
  );

  for (const failAfterOnce of ["thread.create", "thread.activity.append"] as const) {
    it.effect(`recovers an exact retry after a crash following ${failAfterOnce}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness({ failAfterOnce });
        const scope = makeScope();
        const first = yield* harness.service.delegateTask(scope, delegateInput()).pipe(Effect.exit);
        expect(first._tag).toBe("Failure");

        const recovered = yield* harness.service.delegateTask(scope, delegateInput());
        const child = harness.children.get(recovered.taskId)!;
        expect(recovered.status).toBe("queued");
        expect(child.activities.filter(({ kind }) => kind === "delegation.created")).toHaveLength(
          1,
        );
        expect(
          child.messages.filter(({ id }) => id === recovered.lineage.delegatedMessageId),
        ).toHaveLength(1);
        expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(
          1,
        );
      }),
    );
  }

  it.effect("rejects bad model options and permission escalation before child creation", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const badOption = yield* harness.service
        .delegateTask(
          makeScope(),
          delegateInput({
            target: {
              providerInstanceId,
              driverKind,
              model: "gpt-test",
              options: [{ id: "effort", value: "impossible" }],
            },
          }),
        )
        .pipe(Effect.flip);
      expect(badOption.code).toBe("invalid_model_options");

      const escalationHarness = makeHarness({ parentRuntimeMode: "approval-required" });
      const escalation = yield* escalationHarness.service
        .delegateTask(makeScope("approval-required"), delegateInput({ runtimeMode: "full-access" }))
        .pipe(Effect.flip);
      expect(escalation.code).toBe("permission_escalation_denied");
      expect(harness.dispatched).toHaveLength(0);
      expect(escalationHarness.dispatched).toHaveLength(0);
    }),
  );

  it.effect("detects a provider config change before turn start and leaves no provider turn", () =>
    Effect.gen(function* () {
      const changedConfig: ProviderInstanceConfig = {
        ...instanceConfig,
        config: { binaryPath: "different-codex", launchArgs: "" },
      };
      const harness = makeHarness({ settingsSequence: [instanceConfig, changedConfig] });
      const error = yield* harness.service
        .delegateTask(makeScope(), delegateInput())
        .pipe(Effect.flip);

      expect(error.code).toBe("provider_configuration_changed");
      expect(harness.dispatched.map(({ type }) => type)).toEqual([
        "thread.create",
        "thread.activity.append",
      ]);
    }),
  );

  it.effect("binds status and result to the delegated turn after a later ordinary turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const delegatedTurnId = bindDelegatedTurn(
        harness,
        delegated.taskId,
        delegated.lineage.delegatedMessageId,
        "completed",
      );
      const child = harness.children.get(delegated.taskId)!;
      const delegatedAssistantId = MessageId.make("delegated-assistant");
      const laterTurnId = TurnId.make("later-mobile-turn");
      harness.children.set(delegated.taskId, {
        ...child,
        latestTurn: {
          turnId: laterTurnId,
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [
          ...child.messages,
          {
            id: delegatedAssistantId,
            role: "assistant",
            text: "Delegated result",
            turnId: delegatedTurnId,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: MessageId.make("later-assistant"),
            role: "assistant",
            text: "Later mobile result",
            turnId: laterTurnId,
            streaming: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        activities: [
          ...child.activities,
          {
            id: EventId.make("delegation-provider-bound"),
            tone: "info",
            kind: "delegation.provider-bound",
            summary: "Delegated task provider bound",
            payload: {
              version: 1,
              taskId: delegated.taskId,
              delegatedMessageId: delegated.lineage.delegatedMessageId,
              providerInstanceId,
              driverKind,
              providerConfigFingerprint: delegated.requested.providerConfigFingerprint,
              observedAt: now,
            },
            turnId: delegatedTurnId,
            createdAt: now,
          },
          {
            id: EventId.make("delegation-model-observed"),
            tone: "info",
            kind: "delegation.model-observed",
            summary: "Delegated task model observed",
            payload: {
              version: 1,
              taskId: delegated.taskId,
              delegatedMessageId: delegated.lineage.delegatedMessageId,
              delegatedTurnId,
              model: "gpt-test-executed",
              evidence: "provider-executed",
              observedAt: now,
            },
            turnId: delegatedTurnId,
            createdAt: now,
          },
        ],
        checkpoints: [
          {
            turnId: delegatedTurnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-one"),
            status: "ready",
            files: [],
            assistantMessageId: delegatedAssistantId,
            completedAt: now,
          },
        ],
        session: {
          ...child.session!,
          activeTurnId: laterTurnId,
          status: "running",
        },
      });
      harness.turns.set(delegated.taskId, [
        harness.turns.get(delegated.taskId)![0]!,
        {
          ...pendingTurn(delegated.taskId, MessageId.make("later-mobile-message")),
          turnId: laterTurnId,
          state: "running",
          startedAt: now,
        },
      ]);

      const status = yield* harness.service.taskStatus(scope, delegated.taskId);
      expect(status.status).toBe("completed");
      expect(status.lineage.delegatedTurnId).toBe(delegatedTurnId);
      expect(status.result).toMatchObject({
        text: "Delegated result",
        assistantMessageId: delegatedAssistantId,
        checkpointRef: "checkpoint-one",
      });
      expect(status.observed).toMatchObject({
        provider: {
          providerInstanceId,
          driverKind,
          evidence: "runtime-session-bound",
        },
        model: {
          model: "gpt-test-executed",
          evidence: "provider-executed",
        },
      });
      const dispatchCount = harness.dispatched.length;
      const cancelled = yield* harness.service.taskCancel(scope, delegated.taskId);
      expect(cancelled.status).toBe("completed");
      expect(harness.dispatched).toHaveLength(dispatchCount);
    }),
  );

  it.effect("cancels the exact active delegated turn idempotently", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const delegatedTurnId = bindDelegatedTurn(
        harness,
        delegated.taskId,
        delegated.lineage.delegatedMessageId,
      );

      const first = yield* harness.service.taskCancel(scope, delegated.taskId);
      expect(first.status).toBe("cancelled");
      const interrupt = harness.dispatched.findLast(({ type }) => type === "thread.turn.interrupt");
      expect(interrupt).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: delegated.taskId,
        turnId: delegatedTurnId,
      });
      const count = harness.dispatched.length;
      const second = yield* harness.service.taskCancel(scope, delegated.taskId);
      expect(second.status).toBe("cancelled");
      expect(harness.dispatched).toHaveLength(count);
    }),
  );

  it.effect("finds durable task lineage beyond the generic 500-activity window", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const child = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, {
        ...child,
        activities: [
          ...child.activities,
          ...Array.from({ length: 600 }, (_, index) => ({
            id: EventId.make(`noise-${index}`),
            tone: "info" as const,
            kind: "unrelated.activity",
            summary: "Unrelated activity",
            payload: { index },
            turnId: null,
            createdAt: now,
          })),
        ],
      });

      const status = yield* harness.service.taskStatus(scope, delegated.taskId);
      expect(status.taskId).toBe(delegated.taskId);
      expect(status.lineage.delegatedMessageId).toBe(delegated.lineage.delegatedMessageId);
    }),
  );

  it.effect("pins a pre-bind cancellation to the delegated pending message", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());

      const result = yield* harness.service.taskCancel(scope, delegated.taskId);
      expect(result.status).toBe("cancelled");
      expect(
        harness.dispatched.findLast(({ type }) => type === "thread.turn.interrupt"),
      ).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: delegated.taskId,
        pendingMessageId: delegated.lineage.delegatedMessageId,
      });
    }),
  );

  it.effect("keeps failed cancellation non-terminal and retries with a new command id", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ interruptOutcomes: ["failure", "success"] });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      bindDelegatedTurn(harness, delegated.taskId, delegated.lineage.delegatedMessageId);

      const first = yield* harness.service.taskCancel(scope, delegated.taskId);
      expect(first.status).toBe("running");
      const firstInterrupt = harness.dispatched.findLast(
        ({ type }) => type === "thread.turn.interrupt",
      );
      expect(firstInterrupt?.type).toBe("thread.turn.interrupt");

      const second = yield* harness.service.taskCancel(scope, delegated.taskId);
      expect(second.status).toBe("cancelled");
      const interrupts = harness.dispatched.filter(({ type }) => type === "thread.turn.interrupt");
      expect(interrupts).toHaveLength(2);
      expect(interrupts[0]?.commandId).not.toBe(interrupts[1]?.commandId);
    }),
  );

  it.effect("subscribes before reading, and a wait timeout never cancels", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      harness.order.length = 0;
      const result = yield* harness.service.taskWait(scope, delegated.taskId, 1);

      expect(harness.order[0]).toBe("subscribe");
      expect(harness.order[1]).toBe(`detail:${delegated.taskId}`);
      expect(result.status).toBe("queued");
      expect(result.waitTimedOut).toBe(true);
      expect(harness.dispatched.some(({ type }) => type === "thread.turn.interrupt")).toBe(false);
    }),
  );

  it.effect("does not reveal task existence across parent-thread ownership", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const delegated = yield* harness.service.delegateTask(makeScope(), delegateInput());
      const foreignScope = { ...makeScope(), threadId: ThreadId.make("other-parent") };
      const error = yield* harness.service
        .taskStatus(foreignScope, delegated.taskId)
        .pipe(Effect.flip);
      expect(error.code).toBe("task_not_found");
    }),
  );
});
