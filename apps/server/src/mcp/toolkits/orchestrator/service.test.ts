import { describe, expect, it } from "@effect/vitest";
import {
  BoardCard,
  BoardCardEvent,
  BoardCardEventId,
  BoardCardId,
  BoardOrchestrator,
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
  type OrchestratorMcpSendToTaskInput,
  type OrchestratorMcpSwitchProviderInput,
  type ProviderInstanceConfig,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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

const secondProviderInstanceId = ProviderInstanceId.make("codex_two");
const piProviderInstanceId = ProviderInstanceId.make("pi_one");
const piDriverKind = ProviderDriverKind.make("pi");
const piInstanceConfig: ProviderInstanceConfig = {
  driver: piDriverKind,
  enabled: true,
  config: {
    binaryPath: "pi",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "qwen2.5-coder:7b",
  },
};
const piProvider = {
  ...provider,
  instanceId: piProviderInstanceId,
  driver: piDriverKind,
  displayName: "Pi local",
  models: [
    {
      slug: "ft3-local/qwen2.5-coder:7b",
      name: "Qwen Coder",
      isCustom: false,
      capabilities: {},
    },
  ],
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

const sendToTaskInput = (
  taskId: ThreadId,
  overrides: Partial<OrchestratorMcpSendToTaskInput> = {},
) =>
  ({
    taskId,
    idempotencyKey: "follow-up-1",
    message: "Continue with the next implementation step.",
    ...overrides,
  }) satisfies OrchestratorMcpSendToTaskInput;

const switchInput = (
  taskId: ThreadId,
  overrides: Partial<OrchestratorMcpSwitchProviderInput> = {},
) =>
  ({
    taskId,
    target: {
      providerInstanceId: secondProviderInstanceId,
      driverKind,
      model: "gpt-test",
    },
    reason: "The orchestrator provider hit its usage limit.",
    ...overrides,
  }) satisfies OrchestratorMcpSwitchProviderInput;

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

function memoryChild(
  threadId: ThreadId,
  input: {
    parentThreadId?: ThreadId;
    parentEnvironmentId?: string;
    role?: string;
    archived?: boolean;
  } = {},
): OrchestrationThread {
  const turnId = TurnId.make(`${threadId}-turn`);
  return {
    id: threadId,
    projectId,
    title: `Memory ${threadId}`,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: `${workspaceRoot}/${threadId}`,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: MessageId.make(`${threadId}-assistant`),
    },
    messages: [
      {
        id: MessageId.make(`${threadId}-assistant`),
        role: "assistant",
        text: `Finished ${threadId}.`,
        turnId,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    activities: [
      {
        id: EventId.make(`${threadId}-lineage`),
        tone: "info",
        kind: "delegation.created",
        summary: "Delegated child created",
        payload: {
          version: 1,
          taskId: threadId,
          childThreadId: threadId,
          parentEnvironmentId: input.parentEnvironmentId ?? environmentId,
          parentThreadId: input.parentThreadId ?? parentThreadId,
          parentTurnId,
          projectId,
          delegatedMessageId: MessageId.make(`${threadId}-request`),
          callerRequestFingerprint: "caller-fingerprint",
          requestFingerprint: "request-fingerprint",
          requestedAt: now,
          role: input.role ?? "review",
          workspaceRoot,
          worktreePath: `${workspaceRoot}/${threadId}`,
          requested: { providerInstanceId, driverKind, model: "gpt-test" },
        },
        turnId: null,
        createdAt: now,
      },
    ],
    checkpoints: [],
    proposedPlans: [],
    pullRequests: [],
    session: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: input.archived ? now : null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  } as OrchestrationThread;
}

function shellForMemoryChild(thread: OrchestrationThread): OrchestrationThreadShell {
  const lineage = thread.activities.find((activity) => activity.kind === "delegation.created")!;
  const payload = lineage.payload as {
    parentThreadId: ThreadId;
    parentEnvironmentId: string;
    role: string;
  };
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    delegationParent: {
      parentThreadId: payload.parentThreadId,
      parentEnvironmentId: payload.parentEnvironmentId,
      role: payload.role,
    },
  } as OrchestrationThreadShell;
}

function ordinaryThreadDetail(): OrchestrationThread {
  const shell = parentShell();
  const turnId = TurnId.make("ordinary-turn");
  return {
    id: parentThreadId,
    projectId,
    title: "Ordinary",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    messages: [
      {
        id: MessageId.make("ordinary-user-1"),
        role: "user",
        text: "First.",
        turnId,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MessageId.make("ordinary-assistant-1"),
        role: "assistant",
        text: "Done.",
        turnId,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    pullRequests: [],
    session: shell.session,
    createdAt: now,
    updatedAt: now,
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
  readonly includeSecondProvider?: boolean;
  readonly includePiProvider?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly disableSecondProvider?: boolean;
  readonly parentRuntimeMode?: RuntimeMode;
  readonly failParentDetailRead?: { active: boolean };
  readonly interruptOutcomes?: ReadonlyArray<"failure" | "success">;
  readonly failAfterOnce?: "thread.create" | "thread.activity.append";
  readonly failAfterFollowUpReceiptOnce?: boolean;
  readonly failAfterFollowUpStartOnce?: boolean;
  readonly switchChildModelBeforeFollowUpStart?: boolean;
  readonly beforeDispatch?: (command: OrchestrationCommand) => Effect.Effect<void>;
  readonly patchParentShell?: (shell: OrchestrationThreadShell) => OrchestrationThreadShell;
  readonly board?: NonNullable<OrchestratorMcpDependencies["board"]>;
}

function gateConcurrentFollowUpReceipts() {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return (command: OrchestrationCommand) => {
    if (
      command.type !== "thread.activity.append" ||
      command.activity.kind !== "delegation.follow-up-queued"
    ) {
      return Effect.void;
    }
    return Effect.promise(() => {
      arrivals += 1;
      if (arrivals === 2) release();
      return bothArrived;
    });
  };
}

// Holds the first switch commit dispatch until both racers have finished
// their pre-commit chain-head reads. Each racer performs exactly two
// thread-detail reads before committing (initial load plus readOwnedTask)
// plus the winner's in-commit re-read, so the gate waits for five reads
// past the post-delegation baseline. Pre-commit reads stay lock-free, so
// the gate cannot deadlock: the loser only blocks on the commit lock
// afterwards and then re-reads the winner's record. The threshold is tied
// to the current read budget — recount it if the pre-commit path changes.
function gateFirstSwitchMetaUntilBothHeadsRead(
  detailReads: () => number,
  threshold: () => number,
  childId: () => ThreadId | null,
) {
  let arrivals = 0;
  return (command: OrchestrationCommand) => {
    const taskId = childId();
    if (
      taskId === null ||
      command.type !== "thread.meta.update" ||
      String(command.threadId) !== String(taskId)
    ) {
      return Effect.void;
    }
    arrivals += 1;
    if (arrivals > 1) return Effect.void;
    return Effect.gen(function* () {
      // yieldNow, not sleep: the gate must not depend on the Effect clock.
      while (detailReads() < threshold()) {
        yield* Effect.yieldNow;
      }
    });
  };
}

function makeHarness(options: HarnessOptions = {}): {
  readonly service: OrchestratorMcpServiceShape;
  readonly recreateService: () => OrchestratorMcpServiceShape;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly children: Map<ThreadId, OrchestrationThread>;
  readonly turns: Map<ThreadId, Array<ProjectionTurn>>;
  readonly order: Array<string>;
  readonly dependencies: OrchestratorMcpDependencies;
} {
  const dispatched: Array<OrchestrationCommand> = [];
  const children = new Map<ThreadId, OrchestrationThread>();
  const turns = new Map<ThreadId, Array<ProjectionTurn>>();
  const order: Array<string> = [];
  let settingsRead = 0;
  let interruptAttempt = 0;
  let injectedDispatchFailure = false;
  let injectedFollowUpReceiptFailure = false;
  let injectedFollowUpStartFailure = false;

  const dependencies: OrchestratorMcpDependencies = {
    dispatch: (command) => {
      const persist = Effect.sync(() => {
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
            if (options.switchChildModelBeforeFollowUpStart) {
              children.set(command.threadId, {
                ...child,
                modelSelection: { instanceId: providerInstanceId, model: "switched-model" },
              });
            }
            const messageExists = child.messages.some(
              (message) => message.id === command.message.messageId,
            );
            children.set(command.threadId, {
              ...child,
              messages: messageExists
                ? child.messages
                : [
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
            const rows = turns.get(command.threadId) ?? [];
            if (!rows.some((row) => row.pendingMessageId === command.message.messageId)) {
              rows.push(pendingTurn(command.threadId, command.message.messageId));
            }
            turns.set(command.threadId, rows);
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
        if (
          options.failAfterFollowUpReceiptOnce &&
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.follow-up-queued" &&
          !injectedFollowUpReceiptFailure
        ) {
          injectedFollowUpReceiptFailure = true;
          throw new Error("injected failure after follow-up receipt append");
        }
        if (
          options.failAfterFollowUpStartOnce &&
          command.type === "thread.turn.start" &&
          command.followUpBehavior === "queue" &&
          !injectedFollowUpStartFailure
        ) {
          injectedFollowUpStartFailure = true;
          throw new Error("injected failure after queued follow-up start append");
        }
        return { sequence: dispatched.length };
      });
      return options.beforeDispatch === undefined
        ? persist
        : options.beforeDispatch(command).pipe(Effect.andThen(persist));
    },
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
    listDelegatedTaskMemoryRows: ({
      parentEnvironmentId,
      parentThreadId: requestedParentThreadId,
      afterTaskId,
      taskId,
      limit,
    }) =>
      Effect.sync(() => {
        const matching = [...children.values()]
          .filter((child) => {
            const lineage = child.activities.findLast(
              (activity) =>
                activity.kind === "delegation.created" && Predicate.isObject(activity.payload),
            );
            if (lineage === undefined || !Predicate.isObject(lineage.payload)) return false;
            return (
              lineage.payload.parentEnvironmentId === parentEnvironmentId &&
              lineage.payload.parentThreadId === requestedParentThreadId &&
              (taskId === undefined || child.id === taskId) &&
              (afterTaskId === undefined || child.id > afterTaskId)
            );
          })
          .toSorted((left, right) => left.id.localeCompare(right.id));
        const page = matching.slice(0, limit + 1);
        const rows = page.slice(0, limit).map((child) => {
          const lineage = child.activities.findLast(
            (activity) =>
              activity.kind === "delegation.created" && Predicate.isObject(activity.payload),
          );
          const payload =
            lineage !== undefined && Predicate.isObject(lineage.payload) ? lineage.payload : {};
          const followUp = child.activities.findLast(
            (activity) =>
              activity.kind === "delegation.follow-up-queued" &&
              Predicate.isObject(activity.payload),
          );
          const followUpPayload =
            followUp !== undefined && Predicate.isObject(followUp.payload) ? followUp.payload : {};
          const result = Predicate.isObject(followUpPayload.result) ? followUpPayload.result : {};
          const pendingMessageId = typeof result.messageId === "string" ? result.messageId : null;
          const hasPendingFollowUp =
            pendingMessageId !== null &&
            !(turns.get(child.id) ?? []).some(
              (turn) => turn.pendingMessageId === pendingMessageId && turn.turnId !== null,
            );
          return {
            taskId: child.id,
            projectId: child.projectId,
            role: typeof payload.role === "string" ? payload.role : "unknown",
            title: child.title,
            updatedAt: child.updatedAt,
            worktreePath: child.worktreePath,
            latestTurnId: child.latestTurn?.turnId ?? null,
            latestTurnState: child.latestTurn?.state ?? null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasPendingFollowUp,
            threadWatermark: child.activities.length,
            summary: null,
          };
        });
        return { rows, hasMore: page.length > limit };
      }),
    getThreadDetailById: (threadId, query) =>
      options.failParentDetailRead?.active && threadId === parentThreadId
        ? Effect.sync(() => order.push(`detail:${threadId}`)).pipe(
            Effect.andThen(Effect.die(new Error("injected parent detail read failure"))),
          )
        : Effect.sync(() => {
            order.push(`detail:${threadId}`);
            const child = children.get(threadId);
            if (child === undefined) return Option.none();
            return Option.some({
              ...child,
              activities:
                query?.activityKinds === undefined
                  ? child.activities.slice(-500)
                  : child.activities.filter((activity) =>
                      query.activityKinds?.includes(activity.kind),
                    ),
            });
          }),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [project],
        threads: [...children.values()]
          .filter((thread) => thread.archivedAt === null)
          .map(shellForMemoryChild),
        updatedAt: now,
      }),
    getArchivedShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [project],
        threads: [...children.values()]
          .filter((thread) => thread.archivedAt !== null)
          .map(shellForMemoryChild),
        updatedAt: now,
      }),
    getThreadDetailSnapshotIncludingArchived: (threadId) =>
      Effect.succeed(
        Option.map(
          children.has(threadId) ? Option.some(children.get(threadId)!) : Option.none(),
          (thread) => ({
            snapshotSequence: 1,
            thread,
            page: { beforeCursor: null, hasMore: false, snapshotSequence: 1, threadSequence: 17 },
          }),
        ),
      ),
    listTurnsByThreadId: ({ threadId }) => Effect.succeed(turns.get(threadId) ?? []),
    getProviders: Effect.succeed(
      options.useLegacyProviderConfig
        ? [legacyProvider]
        : [
            provider,
            ...(options.includePiProvider ? [piProvider] : []),
            ...(options.includeSecondProvider || options.disableSecondProvider
              ? [
                  {
                    ...provider,
                    instanceId: secondProviderInstanceId,
                    enabled: !options.disableSecondProvider,
                  } as ServerProvider,
                ]
              : []),
          ],
    ),
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
          : {
              [providerInstanceId]: selected,
              ...(options.includePiProvider ? { [piProviderInstanceId]: piInstanceConfig } : {}),
              ...((options.includeSecondProvider || options.disableSecondProvider
                ? { [secondProviderInstanceId]: selected }
                : {}) as Record<string, ProviderInstanceConfig>),
            },
      } satisfies ServerSettings;
    }),
    loadPermissionEnvelope: (input) =>
      Effect.succeed(
        normalizeDelegationPermissionEnvelope({
          ...input,
          environment: options.environment ?? {},
          providerConfigurationFiles: [],
        }),
      ),
    now: Effect.succeed(now),
    ...(options.board === undefined ? {} : { board: options.board }),
  };
  const service = __testing.makeService(dependencies);
  return {
    service,
    recreateService: () => __testing.makeService(dependencies),
    dispatched,
    children,
    turns,
    order,
    dependencies,
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

type FakeBoardRepository = NonNullable<OrchestratorMcpDependencies["board"]>;

function makeFakeBoard(initialOrchestrators: ReadonlyArray<ThreadId> = []): {
  readonly repo: FakeBoardRepository;
  readonly orchestrators: Map<ThreadId, BoardOrchestrator>;
  readonly cards: Map<BoardCardId, BoardCard>;
  readonly events: Map<BoardCardId, Array<BoardCardEvent>>;
} {
  const orchestrators = new Map<ThreadId, BoardOrchestrator>(
    initialOrchestrators.map((threadId) => [
      threadId,
      { threadId, createdBy: "human" as const, createdAt: now },
    ]),
  );
  const cards = new Map<BoardCardId, BoardCard>();
  const events = new Map<BoardCardId, Array<BoardCardEvent>>();
  const repo: FakeBoardRepository = {
    listOrchestrators: () => Effect.succeed([...orchestrators.values()]),
    addOrchestrator: (input) =>
      Effect.sync(() => {
        const orchestrator: BoardOrchestrator = {
          threadId: input.threadId,
          createdBy: input.createdBy,
          createdAt: input.createdAt,
        };
        orchestrators.set(orchestrator.threadId, orchestrator);
        return orchestrator;
      }),
    removeOrchestrator: (threadId) =>
      Effect.sync(() => {
        orchestrators.delete(threadId);
      }),
    listCards: () => Effect.succeed([...cards.values()]),
    getCard: (cardId) => {
      const card = cards.get(cardId);
      return Effect.succeed(card === undefined ? Option.none() : Option.some(card));
    },
    createCard: (card) =>
      Effect.sync(() => {
        cards.set(card.cardId, card);
        events.set(card.cardId, []);
      }),
    updateCard: (card) =>
      Effect.sync(() => {
        cards.set(card.cardId, card);
      }),
    deleteCard: (cardId) =>
      Effect.sync(() => {
        cards.delete(cardId);
        events.delete(cardId);
      }),
    listEvents: () => Effect.succeed([...events.values()].flat()),
    appendEvent: (event) =>
      Effect.sync(() => {
        events.set(event.cardId, [...(events.get(event.cardId) ?? []), event]);
      }),
  };
  return { repo, orchestrators, cards, events };
}

function seedBoardCard(
  board: ReturnType<typeof makeFakeBoard>,
  overrides: Partial<BoardCard> = {},
): BoardCard {
  const card: BoardCard = {
    cardId: BoardCardId.make(`card-${board.cards.size + 1}`),
    orchestratorThreadId: parentThreadId,
    title: "Seeded card",
    body: "",
    status: "orchestrator",
    createdBy: "orchestrator",
    assignee: null,
    executorRole: "general",
    executorThreadId: null,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: 0,
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  board.cards.set(card.cardId, card);
  board.events.set(card.cardId, []);
  return card;
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

  it.effect("sends a follow-up to the owned child using its current identity", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());

      const result = yield* harness.service.sendToTask(scope, sendToTaskInput(delegated.taskId));
      const start = harness.dispatched.findLast(
        (command) =>
          command.type === "thread.turn.start" && command.message.messageId === result.messageId,
      );

      expect(result).toMatchObject({
        taskId: delegated.taskId,
        status: "queued",
        requested: {
          providerInstanceId,
          driverKind,
          model: "gpt-test",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      expect(start).toMatchObject({
        type: "thread.turn.start",
        commandId: result.commandId,
        threadId: delegated.taskId,
        message: {
          messageId: result.messageId,
          role: "user",
          text: "Continue with the next implementation step.",
          attachments: [],
        },
        followUpBehavior: "queue",
        runtimeMode: "approval-required",
        interactionMode: "default",
        delegationConfigFingerprint: result.requested.providerConfigFingerprint,
      });
      if (start?.type === "thread.turn.start") {
        expect(start.modelSelection).toMatchObject({
          instanceId: providerInstanceId,
          model: "gpt-test",
        });
      }
      expect(result.observed).toEqual({ provider: null, model: null });
      expect(
        harness.children
          .get(delegated.taskId)
          ?.activities.filter(({ kind }) => kind === "delegation.follow-up-queued"),
      ).toHaveLength(1);
    }),
  );

  it.effect("pins the accepted model when child metadata changes before start dispatch", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ switchChildModelBeforeFollowUpStart: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const result = yield* harness.service.sendToTask(scope, sendToTaskInput(delegated.taskId));
      const start = harness.dispatched.findLast(
        (command) =>
          command.type === "thread.turn.start" && command.message.messageId === result.messageId,
      );

      expect(start).toMatchObject({
        type: "thread.turn.start",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
      });
      expect(result.requested.model).toBe("gpt-test");
    }),
  );

  it.effect(
    "returns the same follow-up receipt for exact retries and conflicts on changed text",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const scope = makeScope();
        const delegated = yield* harness.service.delegateTask(scope, delegateInput());
        const request = sendToTaskInput(delegated.taskId);

        const first = yield* harness.service.sendToTask(scope, request);
        const retried = yield* harness.service.sendToTask(scope, request);
        const conflict = yield* harness.service
          .sendToTask(scope, { ...request, message: "Different follow-up under the same key." })
          .pipe(Effect.flip);

        expect(retried).toEqual(first);
        expect(conflict.code).toBe("idempotency_conflict");
        expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(
          2,
        );
        expect(
          harness.children
            .get(delegated.taskId)
            ?.activities.filter(({ kind }) => kind === "delegation.follow-up-queued"),
        ).toHaveLength(1);
      }),
  );

  it.effect("resolves concurrent follow-ups from the persisted idempotency receipt", () =>
    Effect.gen(function* () {
      const conflictHarness = makeHarness({
        beforeDispatch: gateConcurrentFollowUpReceipts(),
      });
      const scope = makeScope();
      const delegated = yield* conflictHarness.service.delegateTask(scope, delegateInput());
      const firstRequest = sendToTaskInput(delegated.taskId);
      const secondRequest = {
        ...firstRequest,
        message: "A different concurrent follow-up.",
      };
      const [first, second] = yield* Effect.all(
        [
          conflictHarness.service.sendToTask(scope, firstRequest).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          ),
          conflictHarness.service.sendToTask(scope, secondRequest).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          ),
        ],
        { concurrency: 2 },
      );
      const success = first._tag === "Right" ? first : second;
      const conflict = first._tag === "Left" ? first : second;
      if (success._tag !== "Right" || conflict._tag !== "Left") {
        throw new Error("Concurrent follow-ups should produce one receipt and one conflict.");
      }
      expect(conflict.left.code).toBe("idempotency_conflict");
      const winningText = first._tag === "Right" ? firstRequest.message : secondRequest.message;
      const delivered = conflictHarness.children
        .get(delegated.taskId)
        ?.messages.filter(({ id }) => id === success.right.messageId);
      expect(delivered).toHaveLength(1);
      expect(delivered?.[0]?.text).toBe(winningText);
      expect(
        conflictHarness.dispatched.filter(
          (command) =>
            command.type === "thread.turn.start" &&
            command.message.messageId === success.right.messageId,
        ),
      ).toHaveLength(1);
      expect(
        conflictHarness.children
          .get(delegated.taskId)
          ?.activities.filter(({ kind }) => kind === "delegation.follow-up-queued"),
      ).toHaveLength(1);

      const retryHarness = makeHarness({
        beforeDispatch: gateConcurrentFollowUpReceipts(),
      });
      const retryDelegated = yield* retryHarness.service.delegateTask(scope, delegateInput());
      const retryRequest = sendToTaskInput(retryDelegated.taskId);
      const [retryOne, retryTwo] = yield* Effect.all(
        [
          retryHarness.service.sendToTask(scope, retryRequest).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          ),
          retryHarness.service.sendToTask(scope, retryRequest).pipe(
            Effect.match({
              onFailure: (left) => ({ _tag: "Left" as const, left }),
              onSuccess: (right) => ({ _tag: "Right" as const, right }),
            }),
          ),
        ],
        { concurrency: 2 },
      );
      if (retryOne._tag !== "Right" || retryTwo._tag !== "Right") {
        throw new Error("Concurrent exact retries should both return the queued receipt.");
      }
      expect(retryTwo.right).toEqual(retryOne.right);
      expect(
        retryHarness.children
          .get(retryDelegated.taskId)
          ?.activities.filter(({ kind }) => kind === "delegation.follow-up-queued"),
      ).toHaveLength(1);
      expect(
        retryHarness.children
          .get(retryDelegated.taskId)
          ?.messages.filter(({ id }) => id === retryOne.right.messageId)
          .map(({ text }) => text),
      ).toEqual([retryRequest.message]);
      expect(
        retryHarness.turns
          .get(retryDelegated.taskId)
          ?.filter((row) => row.pendingMessageId === retryOne.right.messageId),
      ).toHaveLength(1);
    }),
  );

  it.effect("recovers a follow-up retry after its receipt was persisted", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ failAfterFollowUpReceiptOnce: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const request = sendToTaskInput(delegated.taskId);
      const interrupted = yield* harness.service.sendToTask(scope, request).pipe(Effect.exit);
      expect(interrupted._tag).toBe("Failure");

      const recovered = yield* harness.recreateService().sendToTask(scope, request);
      const retried = yield* harness.service.sendToTask(scope, request);
      expect(retried).toEqual(recovered);
      expect(
        harness.children
          .get(delegated.taskId)
          ?.activities.filter(({ kind }) => kind === "delegation.follow-up-queued"),
      ).toHaveLength(1);
      expect(
        harness.children
          .get(delegated.taskId)
          ?.messages.filter(({ id }) => id === recovered.messageId),
      ).toHaveLength(1);
    }),
  );

  it.effect("returns the accepted receipt after a crash following start-event persistence", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ failAfterFollowUpStartOnce: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const request = sendToTaskInput(delegated.taskId);
      const interrupted = yield* harness.service.sendToTask(scope, request).pipe(Effect.exit);
      expect(interrupted._tag).toBe("Failure");

      const recovered = yield* harness.recreateService().sendToTask(scope, request);
      expect(recovered.status).toBe("queued");
      expect(
        harness.dispatched.filter(
          (command) =>
            command.type === "thread.turn.start" && command.commandId === recovered.commandId,
        ),
      ).toHaveLength(1);
      expect(
        harness.children
          .get(delegated.taskId)
          ?.messages.filter(({ id }) => id === recovered.messageId),
      ).toHaveLength(1);
    }),
  );

  it.effect("rejects self, unowned, and another-parent child ids", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const child = harness.children.get(delegated.taskId)!;
      const foreignId = ThreadId.make("foreign-child");
      const foreignActivities = child.activities.map((activity) => {
        if (activity.kind !== "delegation.created") return activity;
        const payload = activity.payload as Record<string, unknown>;
        return {
          ...activity,
          payload: {
            ...payload,
            taskId: foreignId,
            childThreadId: foreignId,
            parentThreadId: ThreadId.make("other-parent"),
          },
        };
      });
      harness.children.set(foreignId, { ...child, id: foreignId, activities: foreignActivities });

      for (const taskId of [parentThreadId, ThreadId.make("missing-child"), foreignId]) {
        const error = yield* harness.service
          .sendToTask(scope, sendToTaskInput(taskId))
          .pipe(Effect.flip);
        expect(error.code).toBe("task_not_found");
      }
      expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(1);
    }),
  );

  it.effect(
    "continues a completed child without changing the original task result or cancellation",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const scope = makeScope();
        const delegated = yield* harness.service.delegateTask(scope, delegateInput());
        bindDelegatedTurn(
          harness,
          delegated.taskId,
          delegated.lineage.delegatedMessageId,
          "completed",
        );

        const sent = yield* harness.service.sendToTask(scope, sendToTaskInput(delegated.taskId));
        const status = yield* harness.service.taskStatus(scope, delegated.taskId);
        const cancelled = yield* harness.service.taskCancel(scope, delegated.taskId);

        expect(sent.status).toBe("queued");
        expect(sent.messageId).not.toBe(delegated.lineage.delegatedMessageId);
        expect(status.status).toBe("completed");
        expect(cancelled.status).toBe("completed");
        expect(harness.dispatched.some(({ type }) => type === "thread.turn.interrupt")).toBe(false);
        expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(
          2,
        );
      }),
  );

  it.effect("queues behind a busy child turn without steering or switching providers", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const originalTurnId = bindDelegatedTurn(
        harness,
        delegated.taskId,
        delegated.lineage.delegatedMessageId,
        "running",
      );

      const sent = yield* harness.service.sendToTask(scope, sendToTaskInput(delegated.taskId));
      const start = harness.dispatched.findLast(
        (command) =>
          command.type === "thread.turn.start" && command.message.messageId === sent.messageId,
      );
      const child = harness.children.get(delegated.taskId)!;

      expect(start).toMatchObject({ followUpBehavior: "queue", threadId: delegated.taskId });
      expect(sent.observed).toMatchObject({
        provider: {
          providerInstanceId,
          driverKind,
          evidence: "runtime-session-bound",
        },
        model: null,
      });
      expect(harness.dispatched.some(({ type }) => type === "thread.turn.interrupt")).toBe(false);
      expect(child.session?.activeTurnId).toBe(originalTurnId);
      expect(child.session?.providerInstanceId).toBe(providerInstanceId);
      expect(
        harness.dispatched.some(
          (command) =>
            command.type === "thread.meta.update" ||
            (command.type === "thread.activity.append" &&
              command.activity.kind === "delegation.provider-switched"),
        ),
      ).toBe(false);
    }),
  );

  it.effect("refuses a follow-up if the child's frozen permission envelope changed", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ parentRuntimeMode: "approval-required" });
      const scope = makeScope("approval-required");
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const child = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, { ...child, runtimeMode: "full-access" });
      const dispatchCount = harness.dispatched.length;

      const error = yield* harness.service
        .sendToTask(scope, sendToTaskInput(delegated.taskId))
        .pipe(Effect.flip);

      expect(error.code).toBe("permission_escalation_denied");
      expect(harness.dispatched).toHaveLength(dispatchCount);
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

  it.effect("delegates explicitly to Pi from full access with empty frozen MCP caps", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includePiProvider: true, environment: {} });
      const result = yield* harness.service.delegateTask(
        makeScope(),
        delegateInput({
          idempotencyKey: "delegate-to-pi",
          target: {
            providerInstanceId: piProviderInstanceId,
            driverKind: piDriverKind,
            model: "ft3-local/qwen2.5-coder:7b",
          },
          runtimeMode: "approval-required",
        }),
      );

      const create = harness.dispatched.find((command) => command.type === "thread.create");
      expect(create).toBeDefined();
      if (create?.type !== "thread.create") return;
      expect(create.branch).toBe("main");
      expect(create.worktreePath).toBeNull();

      const child = harness.children.get(result.taskId)!;
      const lineage = child.activities.find(({ kind }) => kind === "delegation.created");
      const payload = lineage?.payload as Record<string, unknown> | undefined;
      expect(payload).toMatchObject({
        branch: "main",
        workspaceRoot,
        worktreePath: workspaceRoot,
        childCaps: [],
        requested: {
          providerInstanceId: piProviderInstanceId,
          driverKind: piDriverKind,
          runtimeMode: "approval-required",
        },
      });
      const frozenEnvelope = normalizeDelegationPermissionEnvelope({
        driverKind: piDriverKind,
        runtimeMode: "approval-required",
        interactionMode: "default",
        instanceConfig: piInstanceConfig,
        environment: {},
        workspaceRoot,
        worktreePath: workspaceRoot,
        branch: "main",
        t3McpCapabilities: new Set<string>(),
        providerConfigurationFiles: [],
      });
      expect(frozenEnvelope.status).toBe("verified");
      if (frozenEnvelope.status === "verified") {
        expect(payload?.requested).toMatchObject({
          providerConfigFingerprint: frozenEnvelope.fingerprint,
        });
      }
    }),
  );

  it.effect("denies Pi delegation from a narrow parent before thread creation", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        includePiProvider: true,
        parentRuntimeMode: "approval-required",
        environment: {},
      });
      const error = yield* harness.service
        .delegateTask(
          makeScope("approval-required"),
          delegateInput({
            idempotencyKey: "deny-pi-from-narrow-parent",
            target: {
              providerInstanceId: piProviderInstanceId,
              driverKind: piDriverKind,
              model: "ft3-local/qwen2.5-coder:7b",
            },
            runtimeMode: "approval-required",
          }),
        )
        .pipe(Effect.flip);

      expect(error.code).toBe("permission_escalation_denied");
      expect(harness.dispatched.some((command) => command.type === "thread.create")).toBe(false);
      expect(harness.dispatched).toHaveLength(0);
    }),
  );

  it.effect(
    "denies Pi delegation with an unverified launch environment before thread creation",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          includePiProvider: true,
          environment: { NODE_OPTIONS: "--require C:/untrusted/pi-hook.cjs" },
        });
        const error = yield* harness.service
          .delegateTask(
            makeScope(),
            delegateInput({
              idempotencyKey: "deny-pi-with-node-hook",
              target: {
                providerInstanceId: piProviderInstanceId,
                driverKind: piDriverKind,
                model: "ft3-local/qwen2.5-coder:7b",
              },
              runtimeMode: "full-access",
            }),
          )
          .pipe(Effect.flip);

        expect(error.code).toBe("permission_envelope_unverifiable");
        expect(harness.dispatched.some((command) => command.type === "thread.create")).toBe(false);
        expect(harness.dispatched).toHaveLength(0);
      }),
  );

  it.effect("keeps Pi handoff MCP caps empty while preserving the original task envelope", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includePiProvider: true, environment: {} });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(
        scope,
        delegateInput({ runtimeMode: "full-access" }),
      );
      const switched = yield* harness.service.switchProvider(
        scope,
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId: piProviderInstanceId,
            driverKind: piDriverKind,
            model: "ft3-local/qwen2.5-coder:7b",
          },
        }),
      );
      const piEnvelopeInput = {
        driverKind: piDriverKind,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        instanceConfig: piInstanceConfig,
        environment: {},
        workspaceRoot,
        worktreePath: workspaceRoot,
        branch: "main",
        providerConfigurationFiles: [],
      };
      const emptyCaps = normalizeDelegationPermissionEnvelope({
        ...piEnvelopeInput,
        t3McpCapabilities: new Set<string>(),
      });
      const inheritedCaps = normalizeDelegationPermissionEnvelope({
        ...piEnvelopeInput,
        t3McpCapabilities: new Set(["orchestration", "pull-requests"]),
      });

      const originalLineage = harness.children
        .get(delegated.taskId)!
        .activities.find(({ kind }) => kind === "delegation.created");
      expect((originalLineage?.payload as Record<string, unknown>).childCaps).toEqual([
        "orchestration",
        "pull-requests",
      ]);
      expect(emptyCaps.status).toBe("verified");
      expect(inheritedCaps.status).toBe("verified");
      if (emptyCaps.status === "verified" && inheritedCaps.status === "verified") {
        expect(switched.requested.providerConfigFingerprint).toBe(emptyCaps.fingerprint);
        expect(switched.requested.providerConfigFingerprint).not.toBe(inheritedCaps.fingerprint);
      }
    }),
  );

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

  it.effect(
    "reports completed tasks with missing assistant output as unavailable without sending",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const scope = makeScope();
        const delegated = yield* harness.service.delegateTask(scope, delegateInput());
        bindDelegatedTurn(
          harness,
          delegated.taskId,
          delegated.lineage.delegatedMessageId,
          "completed",
        );
        const dispatchCount = harness.dispatched.length;

        const status = yield* harness.service.taskStatus(scope, delegated.taskId);

        expect(status.status).toBe("completed");
        expect(status.result).toMatchObject({
          text: "",
          outputStatus: "unavailable",
          assistantMessageId: null,
        });
        expect(harness.dispatched).toHaveLength(dispatchCount);
        expect(
          harness.dispatched.slice(dispatchCount).some(({ type }) => type === "thread.turn.start"),
        ).toBe(false);
      }),
  );

  it.effect(
    "does not treat a saved Muse text prefix as complete when parent status is unavailable",
    () =>
      Effect.gen(function* () {
        for (const failParentRead of [false, true]) {
          const parentReadFailure = { active: false };
          const harness = makeHarness({ failParentDetailRead: parentReadFailure });
          const scope = makeScope();
          const delegated = yield* harness.service.delegateTask(scope, delegateInput());
          parentReadFailure.active = failParentRead;
          const turnId = bindDelegatedTurn(
            harness,
            delegated.taskId,
            delegated.lineage.delegatedMessageId,
            "completed",
          );
          const child = harness.children.get(delegated.taskId)!;
          const createdActivity = child.activities.map((activity) => {
            if (activity.kind !== "delegation.created" || typeof activity.payload !== "object") {
              return activity;
            }
            const payload = activity.payload as Record<string, unknown>;
            const requested = payload.requested as Record<string, unknown>;
            return {
              ...activity,
              payload: {
                ...payload,
                requested: {
                  ...requested,
                  driverKind: ProviderDriverKind.make("museCode"),
                },
              },
            };
          });
          harness.children.set(delegated.taskId, {
            ...child,
            activities: createdActivity,
            messages: [
              ...child.messages,
              {
                id: MessageId.make(`partial-muse-output-${failParentRead}`),
                role: "assistant",
                text: "partial saved prefix",
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
          });
          const dispatchCount = harness.dispatched.length;

          const status = yield* harness.service.taskStatus(scope, delegated.taskId);

          expect(status.status).toBe("completed");
          expect(status.result).toMatchObject({
            text: "partial saved prefix",
            outputStatus: "unavailable",
          });
          expect(harness.dispatched).toHaveLength(dispatchCount);
        }
      }),
  );

  it.effect("preserves a history-confirmed empty Muse result in task status", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const turnId = bindDelegatedTurn(
        harness,
        delegated.taskId,
        delegated.lineage.delegatedMessageId,
        "completed",
      );
      const child = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, {
        ...child,
        activities: child.activities.map((activity) => {
          if (activity.kind !== "delegation.created" || typeof activity.payload !== "object") {
            return activity;
          }
          const payload = activity.payload as Record<string, unknown>;
          const requested = payload.requested as Record<string, unknown>;
          return {
            ...activity,
            payload: {
              ...payload,
              requested: {
                ...requested,
                driverKind: ProviderDriverKind.make("museCode"),
              },
            },
          };
        }),
      });
      const parent = ordinaryThreadDetail();
      harness.children.set(parentThreadId, {
        ...parent,
        activities: [
          {
            id: EventId.make("muse-empty-completion"),
            tone: "info",
            kind: "delegation.completed",
            summary: "Delegated child completed",
            payload: {
              version: 1,
              childThreadId: delegated.taskId,
              delegatedTurnId: turnId,
              status: "completed",
              outputStatus: "empty",
              completedAt: now,
              resultExcerpt: "Complete provider history confirms no assistant text was produced.",
            },
            turnId: null,
            createdAt: now,
          },
        ],
      });
      const dispatchCount = harness.dispatched.length;

      const status = yield* harness.service.taskStatus(scope, delegated.taskId);

      expect(status.status).toBe("completed");
      expect(status.result).toMatchObject({ text: "", outputStatus: "empty" });
      expect(harness.dispatched).toHaveLength(dispatchCount);
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

  it.effect("keeps a restarted delegated turn non-terminal until the continued turn finishes", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const turnId = bindDelegatedTurn(
        harness,
        delegated.taskId,
        delegated.lineage.delegatedMessageId,
      );
      // Pre-restart partial output is already on the interrupted turn.
      harness.children.set(delegated.taskId, {
        ...harness.children.get(delegated.taskId)!,
        messages: [
          {
            id: MessageId.make("partial-before-restart"),
            role: "assistant",
            text: "partial fragment",
            turnId,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      const interrupted = yield* harness.service.taskStatus(scope, delegated.taskId);
      expect(interrupted.status).toBe("running");
      expect(interrupted.result).toBeNull();

      // The continuation reuses the interrupted turn id, so the continued
      // work's final assistant message lands on that same turn and only then
      // does the delegation become terminal.
      const runningChild = harness.children.get(delegated.taskId)!;
      const runningRow = harness.turns.get(delegated.taskId)![0]!;
      Object.assign(runningRow, { state: "completed", completedAt: now });
      harness.children.set(delegated.taskId, {
        ...runningChild,
        session: {
          ...runningChild.session!,
          status: "ready",
          activeTurnId: null,
        },
        latestTurn: { ...runningChild.latestTurn!, state: "completed", completedAt: now },
        messages: [
          ...runningChild.messages,
          {
            id: MessageId.make("final-after-continuation"),
            role: "assistant",
            text: "the real final report",
            turnId,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      const completed = yield* harness.service.taskStatus(scope, delegated.taskId);
      expect(completed.status).toBe("completed");
      expect(completed.result?.text).toBe("the real final report");
      expect(completed.lineage.delegatedTurnId).toBe(turnId);
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

  it.effect("switches a live delegated thread without losing work", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const childBefore = harness.children.get(delegated.taskId)!;

      const switched = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));

      expect(switched.taskId).toBe(delegated.taskId);
      expect(switched.oldProvider).toMatchObject({
        providerInstanceId,
        driverKind,
        model: "gpt-test",
      });
      expect(switched.requested.providerInstanceId).toBe(secondProviderInstanceId);
      expect(switched.reason).toContain("usage limit");
      expect(switched.scope).toMatchObject({
        messageCount: 1,
        pendingCount: 1,
        lineagePreserved: true,
      });
      expect(switched.advanced).toBe(false);
      expect(switched.task!.status).toBe("queued");
      expect(harness.dispatched.map(({ type }) => type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
        "thread.meta.update",
        "thread.activity.append",
      ]);
      const meta = harness.dispatched.find(({ type }) => type === "thread.meta.update");
      expect(meta).toMatchObject({
        threadId: delegated.taskId,
        modelSelection: { instanceId: secondProviderInstanceId, model: "gpt-test" },
      });
      // Shell identity is untouched: same thread, original lineage intact.
      const child = harness.children.get(delegated.taskId)!;
      expect(child.id).toBe(childBefore.id);
      expect(child.projectId).toBe(childBefore.projectId);
      expect(child.activities.filter(({ kind }) => kind === "delegation.created")).toHaveLength(1);
      expect(
        child.activities.find(({ kind }) => kind === "delegation.created")?.payload,
      ).toMatchObject({ requested: { providerInstanceId } });
      expect(
        child.activities.find(({ kind }) => kind === "delegation.provider-switched")?.payload,
      ).toMatchObject({
        version: 1,
        taskId: delegated.taskId,
        delegatedMessageId: delegated.lineage.delegatedMessageId,
        oldProvider: { providerInstanceId, driverKind, model: "gpt-test" },
        requested: { providerInstanceId: secondProviderInstanceId },
        reason: "The orchestrator provider hit its usage limit.",
        scope: { messageCount: 1, pendingCount: 1, lineagePreserved: true },
      });
      // The queued delegated turn is left alone to drain on the old provider.
      expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(1);
    }),
  );

  it.effect("switches a completed delegated thread for future turns", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      bindDelegatedTurn(
        harness,
        delegated.taskId,
        delegated.lineage.delegatedMessageId,
        "completed",
      );

      const switched = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));

      expect(switched.advanced).toBe(false);
      expect(switched.task?.status).toBe("completed");
      expect(switched.requested.providerInstanceId).toBe(secondProviderInstanceId);
      expect(harness.dispatched.map(({ type }) => type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
        "thread.meta.update",
        "thread.activity.append",
      ]);
      expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(1);
      expect(
        harness.children
          .get(delegated.taskId)
          ?.activities.some(({ kind }) => kind === "delegation.provider-switched"),
      ).toBe(true);
    }),
  );

  it.effect("refuses a switch to a provider that cannot accept the handoff", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ disableSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const dispatchCount = harness.dispatched.length;

      const error = yield* harness.service
        .switchProvider(scope, switchInput(delegated.taskId))
        .pipe(Effect.flip);
      expect(error.code).toBe("provider_handoff_unsupported");
      expect(harness.dispatched).toHaveLength(dispatchCount);
      const child = harness.children.get(delegated.taskId)!;
      expect(child.activities.some(({ kind }) => kind === "delegation.provider-switched")).toBe(
        false,
      );
    }),
  );

  it.effect("refuses a switch when the thread has no history to carry", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const child = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, { ...child, messages: [] });
      harness.turns.set(delegated.taskId, []);
      const dispatchCount = harness.dispatched.length;

      const error = yield* harness.service
        .switchProvider(scope, switchInput(delegated.taskId))
        .pipe(Effect.flip);
      expect(error.code).toBe("thread_has_no_history");
      expect(harness.dispatched).toHaveLength(dispatchCount);
    }),
  );

  it.effect("advances a suppressed delegated turn on the new provider", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      // The delegated turn was rejected before it could queue; the stored
      // prompt is the only history and must be replayed, not restarted.
      harness.turns.set(delegated.taskId, []);

      const switched = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));

      expect(switched.advanced).toBe(true);
      expect(switched.scope).toMatchObject({
        messageCount: 1,
        pendingCount: 0,
        lineagePreserved: true,
      });
      const starts = harness.dispatched.filter(({ type }) => type === "thread.turn.start");
      expect(starts).toHaveLength(2);
      const replay = starts[1];
      expect(replay?.type).toBe("thread.turn.start");
      if (replay?.type === "thread.turn.start") {
        expect(replay.message.messageId).toBe(delegated.lineage.delegatedMessageId);
        expect(replay.message.text).toBe("Implement the accepted widget contract.");
        expect(replay.modelSelection).toMatchObject({
          instanceId: secondProviderInstanceId,
          model: "gpt-test",
        });
      }
    }),
  );

  it.effect(
    "sends a follow-up with the frozen narrow caps when the caller surface is broader",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const scope = makeScope();
        const delegated = yield* harness.service.delegateTask(scope, delegateInput());
        // A broader caller surface (device), as the UI picker synthesizes.
        const broadCaps = new Set(["pull-requests", "orchestration", "device"] as const);
        const broadEnvelope = normalizeDelegationPermissionEnvelope({
          driverKind,
          runtimeMode: "full-access",
          interactionMode: "default",
          instanceConfig,
          environment: {},
          workspaceRoot,
          worktreePath: workspaceRoot,
          branch: "main",
          t3McpCapabilities: broadCaps,
          providerConfigurationFiles: [],
        });
        const broadScope: McpInvocationScope = {
          ...scope,
          capabilities: broadCaps,
          orchestration: { ...scope.orchestration!, permissionEnvelope: broadEnvelope },
        };
        const sent = yield* harness.service.sendToTask(
          broadScope,
          sendToTaskInput(delegated.taskId),
        );
        expect(sent.status).toBe("queued");
        // The recorded fingerprint stayed at the frozen narrow set: no device.
        expect(sent.requested.providerConfigFingerprint).toBe(
          delegated.requested.providerConfigFingerprint,
        );
        const child = harness.children.get(delegated.taskId)!;
        expect(
          child.activities.find(({ kind }) => kind === "delegation.created")?.payload,
        ).toMatchObject({ childCaps: ["orchestration", "pull-requests"] });
      }),
  );

  it.effect("keeps a UI-surface switch at the frozen narrow authority", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const uiCaps = new Set(["preview", "device", "pull-requests", "orchestration"] as const);
      const uiEnvelope = normalizeDelegationPermissionEnvelope({
        driverKind,
        runtimeMode: "full-access",
        interactionMode: "default",
        instanceConfig,
        environment: {},
        workspaceRoot,
        worktreePath: workspaceRoot,
        branch: "main",
        t3McpCapabilities: uiCaps,
        providerConfigurationFiles: [],
      });
      const uiScope: McpInvocationScope = {
        ...scope,
        capabilities: uiCaps,
        orchestration: { ...scope.orchestration!, permissionEnvelope: uiEnvelope },
      };
      const switched = yield* harness.service.switchProvider(
        uiScope,
        switchInput(delegated.taskId),
      );
      expect(switched.requested.providerInstanceId).toBe(secondProviderInstanceId);
      // No device was smuggled into the recorded fingerprint: same config,
      // same frozen caps, so the fingerprint is unchanged.
      expect(switched.requested.providerConfigFingerprint).toBe(
        delegated.requested.providerConfigFingerprint,
      );
      // The projector applies the switch to the child shell; the harness
      // does not, so simulate it before the follow-up.
      const uiChild = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, {
        ...uiChild,
        modelSelection: {
          instanceId: switched.requested.providerInstanceId,
          model: switched.requested.model,
        },
      });
      // A later narrow MCP send still verifies against the recorded identity.
      const sent = yield* harness.service.sendToTask(scope, sendToTaskInput(delegated.taskId));
      expect(sent.status).toBe("queued");
      expect(sent.requested.providerConfigFingerprint).toBe(
        switched.requested.providerConfigFingerprint,
      );
    }),
  );

  it.effect("recovers legacy lineage without a caps snapshot for switch and send", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const child = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, {
        ...child,
        activities: child.activities.map((activity) => {
          if (activity.kind !== "delegation.created") return activity;
          const payload = { ...(activity.payload as Record<string, unknown>) };
          delete payload.childCaps;
          return { ...activity, payload };
        }),
      });
      const switched = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));
      expect(switched.requested.providerInstanceId).toBe(secondProviderInstanceId);
      expect(switched.requested.providerConfigFingerprint).toBe(
        delegated.requested.providerConfigFingerprint,
      );
      const legacyChild = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, {
        ...legacyChild,
        modelSelection: {
          instanceId: switched.requested.providerInstanceId,
          model: switched.requested.model,
        },
      });
      const sent = yield* harness.service.sendToTask(scope, sendToTaskInput(delegated.taskId));
      expect(sent.status).toBe("queued");
    }),
  );

  it.effect("fails closed when legacy lineage no longer matches the current config", () =>
    Effect.gen(function* () {
      const changedConfig: ProviderInstanceConfig = {
        ...instanceConfig,
        config: { binaryPath: "different-codex", launchArgs: "" },
      };
      const harness = makeHarness({
        includeSecondProvider: true,
        settingsSequence: [instanceConfig, instanceConfig, changedConfig],
      });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const child = harness.children.get(delegated.taskId)!;
      harness.children.set(delegated.taskId, {
        ...child,
        activities: child.activities.map((activity) => {
          if (activity.kind !== "delegation.created") return activity;
          const payload = { ...(activity.payload as Record<string, unknown>) };
          delete payload.childCaps;
          return { ...activity, payload };
        }),
      });
      const error = yield* harness.service
        .switchProvider(scope, switchInput(delegated.taskId))
        .pipe(Effect.flip);
      expect(error.code).toBe("provider_configuration_changed");
    }),
  );

  it.effect("fails a follow-up when the child config drifted after delegation", () =>
    Effect.gen(function* () {
      const changedConfig: ProviderInstanceConfig = {
        ...instanceConfig,
        config: { binaryPath: "different-codex", launchArgs: "" },
      };
      const harness = makeHarness({
        settingsSequence: [instanceConfig, instanceConfig, changedConfig],
      });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const error = yield* harness.service
        .sendToTask(scope, sendToTaskInput(delegated.taskId))
        .pipe(Effect.flip);
      expect(error.code).toBe("provider_configuration_changed");
    }),
  );

  it.effect("treats a repeated switch to the same target as a no-op", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const first = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));
      const dispatchCount = harness.dispatched.length;
      const second = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));
      expect(harness.dispatched).toHaveLength(dispatchCount);
      expect(second.switchedAt).toBe(first.switchedAt);
      expect(second.oldProvider).toEqual({
        providerInstanceId: secondProviderInstanceId,
        driverKind,
        model: "gpt-test",
      });
      expect(second.requested).toEqual(first.requested);
      expect(second.advanced).toBe(false);
      expect(second.task?.status).toBe("queued");
    }),
  );

  it.effect("records A-B-A switches with distinct transition command ids", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const toSecond = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));
      expect(toSecond.oldProvider).toMatchObject({ providerInstanceId });
      const back = yield* harness.service.switchProvider(
        scope,
        switchInput(delegated.taskId, {
          target: { providerInstanceId, driverKind, model: "gpt-test" },
        }),
      );
      // The way back is a real switch, not a no-op: the current identity is
      // the second provider, and the record names it as the source.
      expect(back.oldProvider).toMatchObject({ providerInstanceId: secondProviderInstanceId });
      expect(back.requested.providerInstanceId).toBe(providerInstanceId);
      // The harness clock is frozen, so switchedAt cannot differ here; the
      // transition command IDs below prove the records are distinct.
      const metas = harness.dispatched.filter(({ type }) => type === "thread.meta.update");
      expect(metas).toHaveLength(2);
      expect(metas[0]?.commandId).not.toBe(metas[1]?.commandId);
      const lineages = harness.dispatched.filter(({ type }) => type === "thread.activity.append");
      expect(lineages).toHaveLength(3);
      const switchLineages = lineages.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.provider-switched",
      );
      expect(switchLineages).toHaveLength(2);
      expect(switchLineages[0]?.commandId).not.toBe(switchLineages[1]?.commandId);
    }),
  );

  it.effect("distinguishes parallel switches to different models", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      const low = yield* harness.service.switchProvider(
        scope,
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId: secondProviderInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "low" }],
          },
        }),
      );
      const high = yield* harness.service.switchProvider(
        scope,
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId: secondProviderInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "high" }],
          },
        }),
      );
      // Different options mean different targets: no no-op, distinct records.
      expect(high.oldProvider).toMatchObject({
        providerInstanceId: secondProviderInstanceId,
        model: "gpt-test",
      });
      expect(high.requested).not.toEqual(low.requested);
      const switchLineages = harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.provider-switched",
      );
      expect(switchLineages).toHaveLength(2);
      expect(switchLineages[0]?.commandId).not.toBe(switchLineages[1]?.commandId);
    }),
  );

  it.effect("serializes overlapping switches to different targets instead of forking", () =>
    Effect.gen(function* () {
      let box: { readonly order: Array<string> } | null = null;
      let childId: ThreadId | null = null;
      let baselineReads = 0;
      const detailReads = () =>
        (box?.order ?? []).filter((entry) => entry === `detail:${String(childId)}`).length;
      const harness = makeHarness({
        includeSecondProvider: true,
        beforeDispatch: gateFirstSwitchMetaUntilBothHeadsRead(
          detailReads,
          () => baselineReads + 5,
          () => childId,
        ),
      });
      box = harness;
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      childId = delegated.taskId;
      baselineReads = detailReads();
      const toLow = () =>
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId: secondProviderInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "low" }],
          },
        });
      const toHigh = () =>
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId: secondProviderInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "high" }],
          },
        });
      const [left, right] = yield* Effect.all(
        [
          harness.service.switchProvider(scope, toLow()).pipe(
            Effect.match({
              onFailure: (failure) => ({ _tag: "Left" as const, failure }),
              onSuccess: (result) => ({ _tag: "Right" as const, result }),
            }),
          ),
          harness.service.switchProvider(scope, toHigh()).pipe(
            Effect.match({
              onFailure: (failure) => ({ _tag: "Left" as const, failure }),
              onSuccess: (result) => ({ _tag: "Right" as const, result }),
            }),
          ),
        ],
        { concurrency: 2 },
      );
      if (left._tag !== "Right" || right._tag !== "Right") {
        throw new Error("Overlapping switches to different targets should serialize, not fail.");
      }
      const switchLineages = harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.provider-switched",
      );
      expect(switchLineages).toHaveLength(2);
      expect(switchLineages[0]?.commandId).not.toBe(switchLineages[1]?.commandId);
      const payloads = switchLineages.map((command) =>
        command.type === "thread.activity.append"
          ? (command.activity.payload as unknown as {
              readonly oldProvider: unknown;
              readonly requested: unknown;
              readonly prevTransition: unknown;
            })
          : undefined,
      );
      const firstPayload = payloads[0];
      const secondPayload = payloads[1];
      // Serialized, not forked: the second record chains from the first one.
      // oldProvider is the 3-field transition source, so compare it against
      // the winner's requested identity projected to the same shape.
      const firstRequested = firstPayload?.requested as
        | {
            readonly providerInstanceId: unknown;
            readonly driverKind: unknown;
            readonly model: unknown;
          }
        | undefined;
      expect(secondPayload?.oldProvider).toEqual({
        providerInstanceId: firstRequested?.providerInstanceId,
        driverKind: firstRequested?.driverKind,
        model: firstRequested?.model,
      });
      expect(secondPayload?.prevTransition).not.toBe(firstPayload?.prevTransition);
      // Both transitions were accepted exactly once.
      const requesteds = [left.result.requested, right.result.requested];
      expect(requesteds).toContainEqual(firstPayload?.requested);
      expect(requesteds).toContainEqual(secondPayload?.requested);
      // Read budget guard: 2 racers x (2 pre-commit reads + 1 in-commit
      // re-read + 1 final read). Recount if the pre-commit path changes.
      expect(detailReads()).toBe(baselineReads + 8);
    }),
  );

  it.effect("evicts per-task commit locks once switches settle", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const before = __testing.switchCommitLockCount();
      const switches = 25;
      for (let index = 0; index < switches; index++) {
        const delegated = yield* harness.service.delegateTask(
          scope,
          delegateInput({ idempotencyKey: `evict-widget-${index}` }),
        );
        const switched = yield* harness.service.switchProvider(
          scope,
          switchInput(delegated.taskId),
        );
        expect(switched.taskId).toBe(delegated.taskId);
        expect(switched.requested.providerInstanceId).toBe(secondProviderInstanceId);
      }
      // 25 distinct task IDs left no lock entries behind.
      expect(__testing.switchCommitLockCount()).toBe(before);
    }),
  );

  it.effect("mints distinct command ids across a full A-B-A-B options cycle", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      // Same provider, same model, same options every time: the review's
      // exact collision scenario. Only the transition chain distinguishes
      // the two A→B legs.
      const toSecond = () =>
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId: secondProviderInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "low" }],
          },
        });
      const toFirst = () =>
        switchInput(delegated.taskId, {
          target: {
            providerInstanceId,
            driverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "low" }],
          },
        });
      const first = yield* harness.service.switchProvider(scope, toSecond());
      expect(first.oldProvider).toMatchObject({ providerInstanceId });
      const back = yield* harness.service.switchProvider(scope, toFirst());
      expect(back.oldProvider).toMatchObject({ providerInstanceId: secondProviderInstanceId });
      const again = yield* harness.service.switchProvider(scope, toSecond());
      // The second A→B is a real switch, not a no-op and not a replay of
      // the first leg's receipt: it names the current source honestly.
      expect(again.oldProvider).toMatchObject({ providerInstanceId });
      expect(again.requested.providerInstanceId).toBe(secondProviderInstanceId);
      const switchLineages = harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.provider-switched",
      );
      expect(switchLineages).toHaveLength(3);
      const lineageIds = switchLineages.map((command) => command.commandId);
      expect(new Set(lineageIds).size).toBe(3);
      const metas = harness.dispatched.filter(({ type }) => type === "thread.meta.update");
      expect(metas).toHaveLength(3);
      expect(new Set(metas.map((command) => command.commandId)).size).toBe(3);
      // The durable chain advances every leg: three distinct links, with the
      // two A→B legs (first and third) carrying different transitions.
      const chains = switchLineages.map((command) =>
        command.type === "thread.activity.append"
          ? (command.activity.payload as unknown as { prevTransition: unknown }).prevTransition
          : undefined,
      );
      expect(new Set(chains).size).toBe(3);
      expect(chains[2]).not.toBe(chains[0]);
    }),
  );

  it.effect("replays a lost switch-start on a same-target retry without a new switch record", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const delegated = yield* harness.service.delegateTask(scope, delegateInput());
      // The delegated turn was suppressed before it could queue.
      harness.turns.set(delegated.taskId, []);
      const first = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));
      expect(first.advanced).toBe(true);
      expect(harness.dispatched.filter(({ type }) => type === "thread.turn.start")).toHaveLength(2);
      // The replay was lost before the reactor ran: no bound turn, no row.
      harness.turns.set(delegated.taskId, []);
      const metaCount = harness.dispatched.filter(
        ({ type }) => type === "thread.meta.update",
      ).length;
      const lineageCount = harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.provider-switched",
      ).length;
      const second = yield* harness.service.switchProvider(scope, switchInput(delegated.taskId));
      expect(second.switchedAt).toBe(first.switchedAt);
      expect(second.requested).toEqual(first.requested);
      expect(second.advanced).toBe(true);
      // Exactly one new dispatch (the replay); the switch record is untouched.
      const starts = harness.dispatched.filter(({ type }) => type === "thread.turn.start");
      expect(starts).toHaveLength(3);
      expect(starts[2]?.type).toBe("thread.turn.start");
      if (starts[2]?.type === "thread.turn.start") {
        expect(starts[2].followUpBehavior).toBe("queue");
        expect(starts[2].message.messageId).toBe(delegated.lineage.delegatedMessageId);
      }
      expect(harness.dispatched.filter(({ type }) => type === "thread.meta.update").length).toBe(
        metaCount,
      );
      expect(
        harness.dispatched.filter(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "delegation.provider-switched",
        ).length,
      ).toBe(lineageCount);
    }),
  );

  it.effect("switches an ordinary thread with a session without lineage", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const before = ordinaryThreadDetail();
      harness.children.set(parentThreadId, before);
      const queued = pendingTurn(parentThreadId, MessageId.make("ordinary-pending-1"));
      harness.turns.set(parentThreadId, [queued]);

      const switched = yield* harness.service.switchProvider(scope, switchInput(parentThreadId));

      expect(switched.taskId).toBe(parentThreadId);
      expect(switched.oldProvider).toMatchObject({
        providerInstanceId,
        driverKind,
        model: "gpt-test",
      });
      expect(switched.requested.providerInstanceId).toBe(secondProviderInstanceId);
      expect(switched.reason).toContain("usage limit");
      expect(switched.scope).toMatchObject({
        messageCount: 2,
        pendingCount: 1,
        lineagePreserved: true,
      });
      // An ordinary switch never starts a turn and carries no owned task:
      // queued work drains on the old provider, the next send uses the new one.
      expect(switched.advanced).toBe(false);
      expect(switched.task).toBeNull();
      expect(harness.dispatched.map(({ type }) => type)).toEqual([
        "thread.meta.update",
        "thread.activity.append",
      ]);
      const meta = harness.dispatched.find(({ type }) => type === "thread.meta.update");
      expect(meta).toMatchObject({
        threadId: parentThreadId,
        modelSelection: { instanceId: secondProviderInstanceId, model: "gpt-test" },
      });
      const record = harness.dispatched.find(({ type }) => type === "thread.activity.append");
      expect(record?.type).toBe("thread.activity.append");
      if (record?.type === "thread.activity.append") {
        expect(record.threadId).toBe(parentThreadId);
        expect(record.activity.kind).toBe("delegation.provider-switched");
        expect(record.activity.summary).toBe("Thread switched provider");
        expect(record.activity.payload).toMatchObject({
          version: 1,
          taskId: parentThreadId,
          delegatedMessageId: null,
          oldProvider: { providerInstanceId, driverKind, model: "gpt-test" },
          requested: { providerInstanceId: secondProviderInstanceId },
          reason: "The orchestrator provider hit its usage limit.",
          scope: { messageCount: 2, pendingCount: 1, lineagePreserved: true },
        });
      }
      // History and the pending queue are preserved in place: same thread,
      // same messages, same queued row, no replay.
      const after = harness.children.get(parentThreadId)!;
      expect(after.id).toBe(before.id);
      expect(after.messages).toEqual(before.messages);
      expect(after.activities.some(({ kind }) => kind === "delegation.created")).toBe(false);
      expect(harness.turns.get(parentThreadId)).toEqual([queued]);
    }),
  );

  it.effect("refuses an ordinary switch when the thread has no session", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        includeSecondProvider: true,
        patchParentShell: (shell) => ({ ...shell, session: null }),
      });
      const scope = makeScope();
      harness.children.set(parentThreadId, {
        ...ordinaryThreadDetail(),
        session: null,
      } as OrchestrationThread);
      const dispatchCount = harness.dispatched.length;

      const error = yield* harness.service
        .switchProvider(scope, switchInput(parentThreadId))
        .pipe(Effect.flip);
      expect(error.code).toBe("parent_not_active");
      expect(error.message).toContain("[reason=parent_no_session]");
      expect(harness.dispatched).toHaveLength(dispatchCount);
    }),
  );

  it.effect("refuses an ordinary switch when the thread has no history to carry", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      harness.children.set(parentThreadId, { ...ordinaryThreadDetail(), messages: [] });
      harness.turns.set(parentThreadId, []);
      const dispatchCount = harness.dispatched.length;

      const error = yield* harness.service
        .switchProvider(scope, switchInput(parentThreadId))
        .pipe(Effect.flip);
      expect(error.code).toBe("thread_has_no_history");
      expect(harness.dispatched).toHaveLength(dispatchCount);
    }),
  );

  it.effect("does not reveal an ordinary thread across scope ownership", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ includeSecondProvider: true });
      const scope = makeScope();
      const foreignId = ThreadId.make("foreign-ordinary-thread");
      harness.children.set(foreignId, { ...ordinaryThreadDetail(), id: foreignId });
      const dispatchCount = harness.dispatched.length;

      const error = yield* harness.service
        .switchProvider(scope, switchInput(foreignId))
        .pipe(Effect.flip);
      expect(error.code).toBe("task_not_found");
      expect(harness.dispatched).toHaveLength(dispatchCount);
    }),
  );

  it.effect("creates a card for the calling orchestrator with provenance and history", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard([parentThreadId]);
      const harness = makeHarness({ board: board.repo });

      const card = yield* harness.service.boardCreateCard(makeScope(), {
        title: "Implement the board toolkits",
        body: "Add the four board tools.",
        executorRole: "implementation",
      });

      expect(card).toMatchObject({
        orchestratorThreadId: parentThreadId,
        status: "orchestrator",
        createdBy: "orchestrator",
        executorRole: "implementation",
        assignee: null,
        failureStreak: 0,
        archived: false,
      });
      expect(board.cards.size).toBe(1);
      const events = board.events.get(BoardCardId.make(card.cardId)) ?? [];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        cardId: card.cardId,
        status: "orchestrator",
        source: "system",
      });
    }),
  );

  it.effect("rejects creation from a thread that is not a registered Coordinator", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard();
      const harness = makeHarness({ board: board.repo });

      const error = yield* harness.service
        .boardCreateCard(makeScope(), {
          title: "Not allowed",
          body: "",
          executorRole: "general",
        })
        .pipe(Effect.flip);

      expect(error.code).toBe("capability_denied");
      expect(error.message).toContain("not a registered board Coordinator");
      expect(board.cards.size).toBe(0);
    }),
  );

  it.effect("appends history only when status or executor changes", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard([parentThreadId]);
      const harness = makeHarness({ board: board.repo });
      const scope = makeScope();
      const card = seedBoardCard(board);

      const renamed = yield* harness.service.boardUpdateCard(scope, {
        cardId: card.cardId,
        body: "Updated context only.",
      });
      expect(renamed.body).toBe("Updated context only.");
      expect((board.events.get(card.cardId) ?? []).length).toBe(0);

      const reviewed = yield* harness.service.boardUpdateCard(scope, {
        cardId: card.cardId,
        status: "review",
      });
      expect(reviewed.status).toBe("review");
      const afterReview = board.events.get(card.cardId) ?? [];
      expect(afterReview).toHaveLength(1);
      expect(afterReview[0]).toMatchObject({ status: "review", body: "status -> review" });

      const repeated = yield* harness.service.boardUpdateCard(scope, {
        cardId: card.cardId,
        status: "review",
      });
      expect(repeated.status).toBe("review");
      expect((board.events.get(card.cardId) ?? []).length).toBe(1);

      const reassigned = yield* harness.service.boardUpdateCard(scope, {
        cardId: card.cardId,
        executorRole: "review",
      });
      expect(reassigned.executorRole).toBe("review");
      const afterExecutor = board.events.get(card.cardId) ?? [];
      expect(afterExecutor).toHaveLength(2);
      expect(afterExecutor[1]).toMatchObject({ executorRole: "review" });
    }),
  );

  it.effect("requires a linked executor before a card can be in progress", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard([parentThreadId]);
      const harness = makeHarness({ board: board.repo });
      const scope = makeScope();
      const card = seedBoardCard(board);

      const missing = yield* harness.service
        .boardUpdateCard(scope, { cardId: card.cardId, status: "in_progress" })
        .pipe(Effect.flip);
      expect(missing.code).toBe("executor_required");
      expect(board.cards.get(card.cardId)).toMatchObject({ status: "orchestrator" });

      const linked = yield* harness.service.boardUpdateCard(scope, {
        cardId: card.cardId,
        status: "in_progress",
        assignee: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode-go/deepseek-v4.1-flash",
        },
        executorThreadId: ThreadId.make("delegated-task:child-1"),
      });
      expect(linked.status).toBe("in_progress");
      expect(linked.executorThreadId).toBe("delegated-task:child-1");
    }),
  );

  it.effect("hides another orchestrator's card from update and delete", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard([parentThreadId, ThreadId.make("other-orchestrator")]);
      const harness = makeHarness({ board: board.repo });
      const foreign = seedBoardCard(board, {
        orchestratorThreadId: ThreadId.make("other-orchestrator"),
      });

      const updateError = yield* harness.service
        .boardUpdateCard(makeScope(), { cardId: foreign.cardId, status: "done" })
        .pipe(Effect.flip);
      expect(updateError.code).toBe("task_not_found");

      const deleteError = yield* harness.service
        .boardDeleteCard(makeScope(), { cardId: foreign.cardId })
        .pipe(Effect.flip);
      expect(deleteError.code).toBe("task_not_found");
      expect(board.cards.get(foreign.cardId)).toMatchObject({ status: "orchestrator" });
    }),
  );

  it.effect("deletes its own card and its history", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard([parentThreadId]);
      const harness = makeHarness({ board: board.repo });
      const scope = makeScope();
      const card = seedBoardCard(board);

      const result = yield* harness.service.boardDeleteCard(scope, { cardId: card.cardId });
      expect(result).toEqual({});
      expect(board.cards.has(card.cardId)).toBe(false);
      expect(board.events.has(card.cardId)).toBe(false);

      const second = yield* harness.service
        .boardDeleteCard(scope, { cardId: card.cardId })
        .pipe(Effect.flip);
      expect(second.code).toBe("task_not_found");
    }),
  );

  it.effect("lists only the calling orchestrator's cards with their events", () =>
    Effect.gen(function* () {
      const board = makeFakeBoard([parentThreadId, ThreadId.make("other-orchestrator")]);
      const harness = makeHarness({ board: board.repo });
      const own = seedBoardCard(board, { order: 2 });
      const ownFirst = seedBoardCard(board, { order: 1, title: "First" });
      seedBoardCard(board, {
        orchestratorThreadId: ThreadId.make("other-orchestrator"),
        title: "Foreign",
      });
      board.events.set(own.cardId, [
        {
          entryId: BoardCardEventId.make("entry-1"),
          cardId: own.cardId,
          at: now,
          status: "orchestrator",
          executorRole: "general",
          model: null,
          effort: null,
          source: "system",
        },
      ]);

      const listed = yield* harness.service.boardListCards(makeScope());
      expect(listed.cards.map((entry) => entry.card.cardId)).toEqual([ownFirst.cardId, own.cardId]);
      expect(listed.cards[1]?.events).toHaveLength(1);
      expect(
        listed.cards.every((entry) => entry.card.orchestratorThreadId === parentThreadId),
      ).toBe(true);
    }),
  );

  it.effect(
    "lists, searches, and reads only direct children with stable pagination, including archived",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const firstId = ThreadId.make("memory-child-a");
        const archivedId = ThreadId.make("memory-child-b");
        const foreignId = ThreadId.make("memory-child-foreign");
        const first = memoryChild(firstId, { role: "implementation" });
        const archivedBase = memoryChild(archivedId, { role: "review", archived: true });
        const archived = {
          ...archivedBase,
          activities: [
            ...archivedBase.activities,
            {
              id: EventId.make("memory-child-b-follow-up"),
              tone: "info" as const,
              kind: "delegation.follow-up-queued",
              summary: "Follow-up queued",
              payload: {
                result: { messageId: MessageId.make("memory-child-b-follow-up-message") },
              },
              turnId: null,
              createdAt: now,
            },
          ],
        } as OrchestrationThread;
        const foreign = memoryChild(foreignId, {
          parentEnvironmentId: "different-environment",
          parentThreadId: ThreadId.make("different-parent"),
        });
        harness.children.set(firstId, first);
        harness.children.set(archivedId, archived);
        harness.children.set(foreignId, foreign);

        const firstPage = yield* harness.service.taskList(makeScope(), { limit: 1 });
        expect(firstPage.tasks.map((task) => task.taskId)).toEqual([firstId]);
        expect(firstPage.nextCursor).toBe(firstId);
        expect(firstPage.tasks[0]?.summary).toMatchObject({
          source: "deterministic",
          state: "pending",
          stale: true,
        });

        const secondPage = yield* harness.service.taskList(makeScope(), {
          limit: 1,
          afterTaskId: firstId,
        });
        expect(secondPage.tasks.map((task) => task.taskId)).toEqual([archivedId]);
        expect(secondPage.nextCursor).toBeNull();
        expect(secondPage.tasks[0]?.latestStatus).toBe("queued");
        expect(secondPage.tasks[0]?.summary?.stale).toBe(true);

        const searched = yield* harness.service.taskSearch(makeScope(), {
          query: `${workspaceRoot}/${archivedId}`,
        });
        expect(searched.tasks.map((task) => task.taskId)).toEqual([archivedId]);
        const exactIdSearch = yield* harness.service.taskSearch(makeScope(), { query: archivedId });
        expect(exactIdSearch.tasks.map((task) => task.taskId)).toEqual([archivedId]);
        const exactTurnSearch = yield* harness.service.taskSearch(makeScope(), {
          query: archived.latestTurn!.turnId,
        });
        expect(exactTurnSearch.tasks.map((task) => task.taskId)).toEqual([archivedId]);
        const metadataSearch = yield* harness.service.taskSearch(makeScope(), { query: "review" });
        expect(metadataSearch.tasks.map((task) => task.taskId)).toEqual([archivedId]);

        const transcript = yield* harness.service.taskRead(makeScope(), {
          taskId: archivedId,
          turnLimit: 1,
        });
        expect(transcript.taskId).toBe(archivedId);
        expect(transcript.messages[0]?.text).toBe(`Finished ${archivedId}.`);
        expect(transcript.page.threadSequence).toBe(17);

        const denied = yield* harness.service
          .taskRead(makeScope(), { taskId: foreignId })
          .pipe(Effect.flip);
        expect(denied.code).toBe("task_not_found");
      }),
  );

  it.effect("scrubs credentials from delegated metadata, snippets, and search input", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
      const taskId = ThreadId.make("memory-child-secret");
      const base = memoryChild(taskId, { role: `api_key=${secret}` });
      const child = {
        ...base,
        title: `Task token=${secret}`,
        worktreePath: `${workspaceRoot}/${secret}`,
        activities: base.activities.map((activity) => {
          if (activity.kind !== "delegation.created" || !Predicate.isObject(activity.payload)) {
            return activity;
          }
          return {
            ...activity,
            payload: { ...activity.payload, role: `api_key=${secret}` },
          };
        }),
      } as OrchestrationThread;
      harness.children.set(taskId, child);

      const listed = yield* harness.service.taskList(makeScope(), { limit: 1 });
      const entry = listed.tasks[0]!;
      expect(entry.title).not.toContain(secret);
      expect(entry.role).not.toContain(secret);
      expect(entry.worktreePath).not.toContain(secret);
      expect(entry.summary?.text).not.toContain(secret);
      expect(entry.title).toContain("[REDACTED]");

      const searched = yield* harness.service.taskSearch(makeScope(), { query: secret });
      expect(searched.query).not.toContain(secret);
      expect(searched.tasks.map((task) => task.taskId)).toEqual([taskId]);
      expect(searched.tasks[0]?.title).not.toContain(secret);
      expect(searched.tasks[0]?.role).not.toContain(secret);
      expect(searched.tasks[0]?.worktreePath).not.toContain(secret);
      expect(searched.tasks[0]?.summary?.text).not.toContain(secret);
    }),
  );
});
