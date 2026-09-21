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
  type OrchestratorMcpSwitchProviderInput,
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

const secondProviderInstanceId = ProviderInstanceId.make("codex_two");

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
  readonly disableSecondProvider?: boolean;
  readonly parentRuntimeMode?: RuntimeMode;
  readonly interruptOutcomes?: ReadonlyArray<"failure" | "success">;
  readonly failAfterOnce?: "thread.create" | "thread.activity.append";
  readonly patchParentShell?: (shell: OrchestrationThreadShell) => OrchestrationThreadShell;
  readonly board?: NonNullable<OrchestratorMcpDependencies["board"]>;
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
    getProviders: Effect.succeed(
      options.useLegacyProviderConfig
        ? [legacyProvider]
        : [
            provider,
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
              ...((options.includeSecondProvider || options.disableSecondProvider
                ? { [secondProviderInstanceId]: selected }
                : {}) as Record<string, ProviderInstanceConfig>),
            },
      } satisfies ServerSettings;
    }),
    loadPermissionEnvelope: (input) =>
      Effect.succeed(
        normalizeDelegationPermissionEnvelope({ ...input, providerConfigurationFiles: [] }),
      ),
    now: Effect.succeed(now),
    ...(options.board === undefined ? {} : { board: options.board }),
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

  it.effect("rejects creation from a thread that is not a registered orchestrator", () =>
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
});
