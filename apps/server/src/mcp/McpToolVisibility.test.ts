import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATOR_MCP_TOOL_NAMES,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadDelegationParent,
} from "@t3tools/contracts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { CoordinatorArchitectBinding } from "@t3tools/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  BoardCardId,
  EventId,
  MessageId,
  ProviderDriverKind,
  TurnId,
  type BoardCard,
  type OrchestratorMcpArchitectCreateOrGetInput,
  type ModelSelection,
  type CoordinatorArchitectRoutingEvidence,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestratorMcpFailure,
} from "@t3tools/contracts";
import type { OrchestratorMcpDependencies } from "./toolkits/orchestrator/service.ts";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BoardRepository, type BoardRepositoryShape } from "../persistence/Services/Board.ts";
import {
  CoordinatorArchitectRepository,
  type CoordinatorArchitectRepositoryShape,
} from "../persistence/Services/CoordinatorArchitect.ts";
import { CoordinatorArchitectRepositoryLive } from "../persistence/Layers/CoordinatorArchitect.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { requireMcpCapability, McpInvocationContext } from "./McpInvocationContext.ts";
import {
  ALL_KNOWN_TOOL_NAMES,
  isToolVisibleToScope,
  resolveVisibleTools,
} from "./McpToolVisibility.ts";
import { __testing } from "./toolkits/orchestrator/service.ts";

const T = ORCHESTRATOR_MCP_TOOL_NAMES;
const projectId = ProjectId.make("project-1");
const coordinatorId = ThreadId.make("coordinator-1");
const chatId = ThreadId.make("chat-1");
const executorId = ThreadId.make("executor-1");
const architectId = ThreadId.make("architect-1");
const environmentId = EnvironmentId.make("environment-1");
const providerInstanceId = ProviderInstanceId.make("codex");

const envelope = {
  status: "verified" as const,
  fingerprint: "f".repeat(64),
  filesystem: "read-only" as const,
  externalDirectories: "none" as const,
  commandExecution: "none" as const,
  network: "approval-required" as const,
  approvalBypass: false,
  providerTools: [],
  externalTools: [],
  t3McpCapabilities: ["orchestration"],
};

const orchScope = {
  projectId,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  workspaceRoot: "/workspace",
  permissionEnvelope: envelope,
};

const scopeFor = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<string>,
  overrides: {
    readonly role?: McpInvocationScope["controlPlaneRole"];
    readonly orchestration?: McpInvocationScope["orchestration"];
  } = {},
): McpInvocationScope =>
  ({
    environmentId,
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId,
    capabilities: new Set(capabilities),
    // NOTE: `"orchestration" in overrides` (not `=== undefined`) so an
    // explicit `orchestration: undefined` clears the frozen scope instead of
    // silently restoring it. `worktreePath` is per-thread to match the
    // frozen-scope drift gate in `loadSwitchParent`.
    orchestration:
      "orchestration" in overrides
        ? overrides.orchestration
        : { ...orchScope, worktreePath: `/workspace/${String(threadId)}` },
    controlPlaneRole: overrides.role,
  }) as unknown as McpInvocationScope;

const FULL_CAPS = ["preview", "device", "pull-requests", "orchestration"];
const NO_PERIPH_CAPS = ["pull-requests", "orchestration"];
const ARCHITECT_CAPS = ["orchestration"];

const PREVIEW = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
];
const DEVICE = ["device_list", "device_open", "device_screenshot", "device_close"];
const CALENDAR = ["calendar_list", "calendar_create", "calendar_update", "calendar_delete"];
const PULL_REQUESTS = ["link_pull_request", "unlink_pull_request", "list_thread_pull_requests"];
const ANSWER: ReadonlyArray<string> = [T.architectureReviewAnswer, T.prepareCoordinatorPublication];
const TASK_READS: ReadonlyArray<string> = [
  T.taskList,
  T.taskSearch,
  T.taskSummaryHistory,
  T.taskRead,
  T.taskStatus,
  T.taskWait,
];
const BINDING_READS: ReadonlyArray<string> = [T.getCoordinatorBinding, T.listArchitectureReviews];

const sorted = (names: ReadonlySet<string> | ReadonlyArray<string>): Array<string> =>
  [...names].toSorted();

const visibleStatic = (scope: McpInvocationScope): Array<string> =>
  sorted([...ALL_KNOWN_TOOL_NAMES].filter((name) => isToolVisibleToScope(scope, name)));

describe("McpToolVisibility static rule", () => {
  it("covers the whole registered surface (50 tools)", () => {
    assert.strictEqual(ALL_KNOWN_TOOL_NAMES.size, 50);
  });

  it("hides unknown tool names fail-closed", () => {
    const scope = scopeFor(coordinatorId, FULL_CAPS);
    assert.isFalse(isToolVisibleToScope(scope, "board_nuke_everything"));
  });

  it("shows the coordinator everything but the architect answers", () => {
    const scope = scopeFor(coordinatorId, FULL_CAPS);
    assert.deepStrictEqual(
      visibleStatic(scope),
      sorted([...ALL_KNOWN_TOOL_NAMES].filter((name) => !ANSWER.includes(name))),
    );
    assert.strictEqual(visibleStatic(scope).length, 48);
  });

  it("shows the bound architect reads, answers, publish, and calendar only", () => {
    const scope = scopeFor(architectId, ARCHITECT_CAPS, { role: "architect" });
    assert.deepStrictEqual(
      visibleStatic(scope),
      sorted([...TASK_READS, ...ANSWER, T.publishToCoordinator, ...BINDING_READS, ...CALENDAR]),
    );
    assert.strictEqual(visibleStatic(scope).length, 15);
  });

  it("gates preview/device/pull-requests strictly by capability", () => {
    const scope = scopeFor(chatId, NO_PERIPH_CAPS);
    const visible = visibleStatic(scope);
    assert.strictEqual(visible.length, 30);
    for (const name of [...PREVIEW, ...DEVICE]) assert.isFalse(visible.includes(name));
    for (const name of PULL_REQUESTS) assert.isTrue(visible.includes(name));
  });

  it("shows capability-only sessions just pull-requests and preview", () => {
    const scope = scopeFor(chatId, ["pull-requests", "preview"], { orchestration: undefined });
    assert.deepStrictEqual(visibleStatic(scope), sorted([...PULL_REQUESTS, ...PREVIEW]));
  });

  it("hides the whole orchestrator toolkit without the orchestration scope", () => {
    const scope = scopeFor(chatId, FULL_CAPS, { orchestration: undefined });
    // Calendar stays: its call-time gate is capability-only
    // (`requireMcpCapability("orchestration")`), so it remains callable here.
    assert.deepStrictEqual(
      visibleStatic(scope),
      sorted([...PREVIEW, ...DEVICE, ...PULL_REQUESTS, ...CALENDAR]),
    );
  });
});

const boardLayer = (registered: ReadonlyArray<ThreadId>) =>
  Layer.succeed(BoardRepository, {
    listOrchestrators: () => Effect.succeed(registered.map((threadId) => ({ threadId }))),
  } as unknown as BoardRepositoryShape);

const shellLayer = (shells: Readonly<Record<string, { readonly delegationParent?: unknown }>>) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: (threadId: ThreadId) => {
      const shell = (shells as Record<string, unknown>)[String(threadId)];
      return Effect.succeed(
        shell === undefined
          ? Option.none()
          : Option.some({ id: threadId, delegationParent: null, ...(shell as object) }),
      );
    },
  } as unknown as ProjectionSnapshotQueryShape);

const bindingLayer = (bound: ReadonlyArray<string>) =>
  Layer.succeed(CoordinatorArchitectRepository, {
    getActiveBindingByArchitect: (threadId: ThreadId) =>
      Effect.succeed(bound.includes(String(threadId)) ? ({} as CoordinatorArchitectBinding) : null),
  } as unknown as CoordinatorArchitectRepositoryShape);

const dynamicsBase = (
  registered: ReadonlyArray<ThreadId>,
  shells: Readonly<Record<string, { readonly delegationParent?: unknown }>>,
  bound: ReadonlyArray<string>,
) => Layer.mergeAll(boardLayer(registered), shellLayer(shells), bindingLayer(bound));

describe("McpToolVisibility dynamics", () => {
  it.effect("keeps the coordinator surface with registration and a plain shell", () =>
    Effect.gen(function* () {
      const scope = scopeFor(coordinatorId, FULL_CAPS);
      const visible = yield* resolveVisibleTools(scope).pipe(
        Effect.provide(dynamicsBase([coordinatorId], { [String(coordinatorId)]: {} }, [])),
      );
      assert.deepStrictEqual(sorted(visible), visibleStatic(scope));
    }),
  );

  it.effect("hides boards and binding reads from an unregistered chat", () =>
    Effect.gen(function* () {
      const scope = scopeFor(chatId, FULL_CAPS);
      const visible = yield* resolveVisibleTools(scope).pipe(
        Effect.provide(dynamicsBase([coordinatorId], { [String(chatId)]: {} }, [])),
      );
      const names = sorted(visible);
      assert.strictEqual(names.length, 40);
      for (const name of [
        T.boardCreateCard,
        T.boardUpdateCard,
        T.boardDeleteCard,
        T.boardListCards,
        ...BINDING_READS,
        T.publishToCoordinator,
        T.architectureReviewCancel,
      ]) {
        assert.isFalse(names.includes(name), name);
      }
      assert.isTrue(names.includes(T.delegateTask));
      assert.isTrue(names.includes(T.architectCreateOrGet));
    }),
  );

  it.effect("hides boards, management, publish, and binding reads from executors", () =>
    Effect.gen(function* () {
      const scope = scopeFor(executorId, FULL_CAPS);
      const visible = yield* resolveVisibleTools(scope).pipe(
        Effect.provide(
          dynamicsBase(
            [coordinatorId, executorId],
            {
              [String(executorId)]: {
                delegationParent: {
                  parentThreadId: coordinatorId,
                  parentEnvironmentId: "e",
                  role: "executor",
                },
              },
            },
            [],
          ),
        ),
      );
      const names = sorted(visible);
      assert.strictEqual(names.length, 36);
      assert.isTrue(names.includes(T.delegateTask));
      assert.isTrue(names.includes(T.taskList));
    }),
  );

  it.effect("shows the unbound architect calendar only", () =>
    Effect.gen(function* () {
      const scope = scopeFor(architectId, ARCHITECT_CAPS, { role: "architect" });
      const visible = yield* resolveVisibleTools(scope).pipe(
        Effect.provide(dynamicsBase([], { [String(architectId)]: {} }, [])),
      );
      assert.deepStrictEqual(sorted(visible), sorted(CALENDAR));
    }),
  );

  it.effect("shows the bound architect the full architect surface", () =>
    Effect.gen(function* () {
      const scope = scopeFor(architectId, ARCHITECT_CAPS, { role: "architect" });
      const visible = yield* resolveVisibleTools(scope).pipe(
        Effect.provide(dynamicsBase([], { [String(architectId)]: {} }, [String(architectId)])),
      );
      assert.deepStrictEqual(sorted(visible), visibleStatic(scope));
      assert.strictEqual(sorted(visible).length, 15);
    }),
  );

  it.effect("falls back to the static rule when no repository is composed", () =>
    Effect.gen(function* () {
      const scope = scopeFor(chatId, FULL_CAPS);
      assert.deepStrictEqual(sorted(yield* resolveVisibleTools(scope)), visibleStatic(scope));
    }),
  );
});

// ---------------------------------------------------------------------------
// visible == allowed: every shown tool passes the call-time capability gates,
// every hidden tool denies with a capability/role code. Canonical inputs use
// own-scope ids where a role owns any; dangling ids elsewhere. Cross-owner
// ownership denials below the capability level are outside the matrix.
// ---------------------------------------------------------------------------

const eqNow = "2026-09-28T12:00:00.000Z";
const eqDriverKind = ProviderDriverKind.make("codex");
const childId = ThreadId.make("child-1");

const architectModelSelection: ModelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: "max" }],
};

const architectRoutingEvidence = (
  taskEffort: OrchestratorMcpArchitectCreateOrGetInput["taskEffort"],
): CoordinatorArchitectRoutingEvidence => ({
  policyRef: "oc://doc/fe000000-0000-4000-8000-000000000001@10",
  policyRevision: 10,
  role: "architecture",
  taskEffort,
  consideredCandidates: [
    {
      alias: "L",
      providerInstanceId,
      driverKind: eqDriverKind,
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "max" }],
      disposition: "selected",
      reason: "Equality matrix target.",
    },
  ],
});

function eqThreadDetail(
  id: ThreadId,
  overrides: {
    readonly delegationParent?: ThreadDelegationParent | null;
    readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  } = {},
): OrchestrationThread {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: `/workspace/${id}`,
    latestTurn: {
      turnId: TurnId.make(`${id}-turn`),
      state: "running",
      requestedAt: eqNow,
      startedAt: eqNow,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: id,
      status: "running",
      providerName: "codex",
      providerInstanceId,
      runtimeMode: "full-access",
      activeTurnId: TurnId.make(`${id}-turn`),
      lastError: null,
      updatedAt: eqNow,
    },
    messages: [],
    activities: [...(overrides.activities ?? [])],
    checkpoints: [],
    proposedPlans: [],
    pullRequests: [],
    createdAt: eqNow,
    updatedAt: eqNow,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...(overrides.delegationParent === undefined
      ? {}
      : { delegationParent: overrides.delegationParent }),
  } as OrchestrationThread;
}

const eqLineageActivity = (taskId: ThreadId, parentId: ThreadId): OrchestrationThreadActivity =>
  ({
    id: EventId.make(`${taskId}-lineage`),
    tone: "info",
    kind: "delegation.created",
    summary: "Delegated child created",
    payload: {
      version: 1,
      taskId,
      childThreadId: taskId,
      parentEnvironmentId: environmentId,
      parentThreadId: parentId,
      parentTurnId: `${parentId}-turn`,
      projectId,
      delegatedMessageId: MessageId.make(`${taskId}-request`),
      callerRequestFingerprint: "fp-caller",
      requestFingerprint: "fp-request",
      requestedAt: eqNow,
      role: "implementation",
      workspaceRoot: "/workspace",
      worktreePath: `/workspace/${taskId}`,
      requested: {},
    },
    turnId: null,
    createdAt: eqNow,
  }) as OrchestrationThreadActivity;

const eqShellFor = (thread: OrchestrationThread): OrchestrationThreadShell => {
  const shell = {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    session: thread.session,
    delegationParent:
      (thread as unknown as { readonly delegationParent?: unknown }).delegationParent ?? null,
  };
  return shell as unknown as OrchestrationThreadShell;
};

interface EqHarness {
  readonly service: ReturnType<typeof __testing.makeService>;
  readonly threads: Map<ThreadId, OrchestrationThread>;
  readonly cards: Map<string, { readonly cardId: string }>;
}

const makeEqHarness = (store: CoordinatorArchitectRepositoryShape): EqHarness => {
  const threads = new Map<ThreadId, OrchestrationThread>();
  threads.set(coordinatorId, eqThreadDetail(coordinatorId));
  threads.set(chatId, eqThreadDetail(chatId));
  threads.set(
    executorId,
    eqThreadDetail(executorId, {
      delegationParent: {
        parentThreadId: coordinatorId,
        parentEnvironmentId: environmentId,
        role: "executor",
      },
    }),
  );
  threads.set(
    childId,
    eqThreadDetail(childId, {
      delegationParent: {
        parentThreadId: coordinatorId,
        parentEnvironmentId: environmentId,
        role: "executor",
      },
      activities: [eqLineageActivity(childId, coordinatorId)],
    }),
  );
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: eqNow,
    updatedAt: eqNow,
  } as OrchestrationProjectShell;
  const cards = new Map<string, { readonly cardId: string }>();
  const dependencies: OrchestratorMcpDependencies = {
    dispatch: (command) =>
      Effect.suspend(() => {
        if (command.type === "thread.create" && !threads.has(command.threadId)) {
          threads.set(command.threadId, eqThreadDetail(command.threadId));
        }
        return Effect.succeed({ sequence: 0 });
      }),
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    getThreadShellById: (threadId) =>
      Effect.succeed(
        threads.get(threadId)?.deletedAt === null && threads.get(threadId) !== undefined
          ? Option.some(eqShellFor(threads.get(threadId)!))
          : Option.none(),
      ),
    getProjectShellById: () => Effect.succeed(Option.some(project)),
    getThreadDetailById: (threadId) =>
      Effect.succeed(
        threads.get(threadId)?.deletedAt === null && threads.get(threadId) !== undefined
          ? Option.some(threads.get(threadId)!)
          : Option.none(),
      ),
    listTurnsByThreadId: () => Effect.succeed([]),
    getProviders: Effect.succeed([
      {
        instanceId: providerInstanceId,
        driver: eqDriverKind,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: eqNow,
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
                  options: [{ id: "high", label: "High" }],
                },
              ],
            },
          },
          {
            slug: "gpt-6-luna",
            name: "GPT-6 Luna",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning effort",
                  type: "select",
                  options: [{ id: "max", label: "Max" }],
                },
              ],
            },
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ]),
    loadPermissionEnvelope: () => Effect.succeed({ ...envelope }),
    listDelegatedTaskMemoryRows: () => Effect.succeed({ rows: [], hasMore: false as const }),
    listDelegatedTaskSummaryHistory: () => Effect.succeed({ records: [], nextCursor: null }),
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, coordinatorArchitectSplit: true }),
    now: Effect.succeed(eqNow),
    coordinatorArchitect: store,
    getArchitectCreateReceiptStatus: () => Effect.succeed("missing" as const),
    board: {
      listOrchestrators: () =>
        Effect.succeed([
          { threadId: coordinatorId, createdBy: "human" as const, createdAt: eqNow },
        ]),
      addOrchestrator: (input: { readonly threadId: ThreadId }) =>
        Effect.succeed({ threadId: input.threadId, createdBy: "human" as const, createdAt: eqNow }),
      removeOrchestrator: () => Effect.succeed(undefined),
      listCards: () => Effect.succeed([]),
      listNudgeCandidateCards: () => Effect.succeed([]),
      hasWorkingReadyCard: () => Effect.succeed(false),
      hasCardEvent: () => Effect.succeed(false),
      findCardsByPrefix: () => Effect.succeed([]),
      getCard: (cardId: BoardCardId) => {
        const card = cards.get(String(cardId));
        return Effect.succeed(card === undefined ? Option.none() : Option.some(card));
      },
      createCard: (card: BoardCard) =>
        Effect.sync(() => {
          cards.set(String(card.cardId), card as unknown as { readonly cardId: string });
        }),
      updateCard: (card: BoardCard) =>
        Effect.sync(() => {
          cards.set(String(card.cardId), card as unknown as { readonly cardId: string });
        }),
      updateCardWithPrevious: (card: BoardCard) =>
        Effect.sync(() => {
          cards.set(String(card.cardId), card as unknown as { readonly cardId: string });
        }),
      findCardByExecutor: () => Effect.succeed(Option.none()),
      listCardsByExecutor: () => Effect.succeed([]),
      deleteCard: (cardId: BoardCardId) =>
        Effect.sync(() => {
          cards.delete(String(cardId));
        }),
      appendEvent: () => Effect.succeed(undefined),
      listEvents: () => Effect.succeed([]),
      recordDeletion: () => Effect.succeed(undefined),
      getDeletion: () => Effect.succeed(Option.none()),
      listDeletions: () => Effect.succeed([]),
    } as unknown as BoardRepositoryShape,
    revokeThreadCredential: () => Effect.void,
  };
  return { service: __testing.makeService(dependencies), threads, cards };
};

const DENIAL_CODES = new Set([
  "capability_denied",
  "architect_denied",
  "delegated_executor_denied",
]);

const classify = <A>(effect: Effect.Effect<A, OrchestratorMcpFailure>): Effect.Effect<string> =>
  Effect.match(effect, {
    onFailure: (failure) => (DENIAL_CODES.has(failure.code) ? "denied" : `passed:${failure.code}`),
    onSuccess: () => "passed",
  });

const withStore = <A, E = never>(
  use: (store: CoordinatorArchitectRepositoryShape) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        CoordinatorArchitectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      );
      return yield* use(Context.get(context, CoordinatorArchitectRepository));
    }),
  );

const bogusCard = BoardCardId.make("card-9");

describe("visible == allowed across roles", () => {
  it.effect("matches the shown set with the capability verdict for every role", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const harness = makeEqHarness(store);
        const { service } = harness;
        const coordScope = scopeFor(coordinatorId, FULL_CAPS);
        const chatScope = scopeFor(chatId, FULL_CAPS);
        const execScope = scopeFor(executorId, FULL_CAPS);

        const cardA = yield* service.boardCreateCard(coordScope, {
          title: "Card A",
          body: "Body A",
          executorRole: "implementation",
        });
        const cardB = yield* service.boardCreateCard(coordScope, {
          title: "Card B",
          body: "Body B",
          executorRole: "implementation",
        });
        const created = yield* service.architectCreateOrGet(coordScope, {
          coordinatorThreadId: coordinatorId,
          taskEffort: "low",
          idempotencyKey: "eq-bind",
          modelSelection: architectModelSelection,
          routingEvidence: architectRoutingEvidence("low"),
        });
        const archScope = scopeFor(created.architectThreadId, ARCHITECT_CAPS, {
          role: "architect",
        });
        const reviewAnswered = yield* service.architectureReviewRequest(coordScope, {
          coordinatorThreadId: coordinatorId,
          reason: "direct-advice",
          question: "Ship?",
          executionPosture: "continue",
          idempotencyKey: "eq-req-a",
        });
        const reviewOpen = yield* service.architectureReviewRequest(coordScope, {
          coordinatorThreadId: coordinatorId,
          reason: "direct-advice",
          question: "Ship this too?",
          executionPosture: "continue",
          idempotencyKey: "eq-req-b",
        });
        const reviewCancelTarget = yield* service.architectureReviewRequest(coordScope, {
          coordinatorThreadId: coordinatorId,
          reason: "direct-advice",
          question: "Cancel me.",
          executionPosture: "continue",
          idempotencyKey: "eq-req-c",
        });
        yield* service.architectureReviewAnswer(archScope, {
          reviewId: reviewAnswered.reviewId,
          disposition: "recommendation",
          summary: "Ship it.",
          idempotencyKey: "eq-ans-a",
        });
        const bogusReview = "review-does-not-exist" as unknown as typeof reviewAnswered.reviewId;

        const visibilityBase = Layer.mergeAll(
          Layer.succeed(BoardRepository, {
            listOrchestrators: () =>
              Effect.succeed([
                { threadId: coordinatorId, createdBy: "human" as const, createdAt: eqNow },
              ]),
          } as unknown as BoardRepositoryShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: (threadId: ThreadId) =>
              harness.threads.has(threadId)
                ? Effect.succeed(Option.some(eqShellFor(harness.threads.get(threadId)!)))
                : Effect.succeed(Option.none()),
          } as unknown as ProjectionSnapshotQueryShape),
          Layer.succeed(CoordinatorArchitectRepository, store),
        );
        const visibleFor = (scope: McpInvocationScope) =>
          Effect.map(
            resolveVisibleTools(scope).pipe(Effect.provide(visibilityBase)),
            (visible) => new Set(visible),
          );

        const delegateInputFor = (key: string) => ({
          idempotencyKey: key,
          title: "Implement widget",
          prompt: "Implement the accepted widget contract.",
          role: "implementation" as const,
          target: {
            providerInstanceId,
            driverKind: eqDriverKind,
            model: "gpt-test",
            options: [{ id: "effort", value: "high" }],
          },
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        });

        const checkRole = (
          role: string,
          scope: McpInvocationScope,
          probes: Readonly<Record<string, Effect.Effect<unknown, OrchestratorMcpFailure>>>,
        ) =>
          Effect.gen(function* () {
            const visible = yield* visibleFor(scope);
            for (const [toolName, probe] of Object.entries(probes)) {
              const outcome = yield* classify(
                probe as Effect.Effect<unknown, OrchestratorMcpFailure>,
              );
              const shown = visible.has(toolName);
              const passed = outcome === "denied" ? false : true;
              assert.strictEqual(
                shown,
                passed,
                `${role} ${toolName}: shown=${shown} outcome=${outcome}`,
              );
            }
          });

        // Architect first: the coordinator replace/detach probes below rebind.
        yield* checkRole("architect", archScope, {
          [T.taskList]: service.taskList(archScope, { limit: 10 }),
          [T.taskSearch]: service.taskSearch(archScope, { query: "widget" }),
          [T.taskSummaryHistory]: service.taskSummaryHistory(archScope, {}),
          [T.taskRead]: service.taskRead(archScope, { taskId: childId }),
          [T.taskStatus]: service.taskStatus(archScope, childId),
          [T.taskWait]: service.taskWait(archScope, childId, 1),
          [T.architectureReviewAnswer]: service.architectureReviewAnswer(archScope, {
            reviewId: reviewOpen.reviewId,
            disposition: "recommendation",
            summary: "Ship this too.",
            idempotencyKey: "eq-ans-b",
          }),
          [T.prepareCoordinatorPublication]: service.prepareCoordinatorPublication(archScope, {
            summary: "Advice.",
            disposition: "recommendation",
            executionPosture: "continue",
            idempotencyKey: "eq-prep-arch",
          }),
          [T.publishToCoordinator]: service.publishToCoordinator(archScope, {
            reviewId: reviewAnswered.reviewId,
            idempotencyKey: "eq-pub-arch",
          }),
          [T.getCoordinatorBinding]: service.getCoordinatorBinding(archScope, {
            coordinatorThreadId: coordinatorId,
          }),
          [T.listArchitectureReviews]: service.listArchitectureReviews(archScope, {
            coordinatorThreadId: coordinatorId,
          }),
          [T.capabilities]: service.capabilities(archScope),
          [T.delegateTask]: service.delegateTask(archScope, delegateInputFor("eq-arch-delegate")),
          [T.sendToTask]: service.sendToTask(archScope, {
            taskId: childId,
            idempotencyKey: "eq-arch-send",
            message: "hi",
          }),
          [T.taskCancel]: service.taskCancel(archScope, childId),
          [T.switchProvider]: service.switchProvider(archScope, {
            taskId: childId,
            target: { providerInstanceId, driverKind: eqDriverKind, model: "gpt-test" },
            reason: "limit",
          }),
          [T.boardCreateCard]: service.boardCreateCard(archScope, {
            title: "x",
            body: "y",
            executorRole: "implementation",
          }),
          [T.boardUpdateCard]: service.boardUpdateCard(archScope, {
            cardId: cardA.cardId,
            title: "x",
          }),
          [T.boardDeleteCard]: service.boardDeleteCard(archScope, { cardId: cardA.cardId }),
          [T.boardListCards]: service.boardListCards(archScope, {}),
          [T.architectCreateOrGet]: service.architectCreateOrGet(archScope, {
            coordinatorThreadId: coordinatorId,
            taskEffort: "low",
            idempotencyKey: "eq-arch-create",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectReplace]: service.architectReplace(archScope, {
            coordinatorThreadId: coordinatorId,
            taskEffort: "low",
            reason: "stale",
            idempotencyKey: "eq-arch-replace",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectDetach]: service.architectDetach(archScope, {
            coordinatorThreadId: coordinatorId,
            reason: "done",
            idempotencyKey: "eq-detach-arch",
          }),
          [T.architectureReviewRequest]: service.architectureReviewRequest(archScope, {
            coordinatorThreadId: coordinatorId,
            reason: "direct-advice",
            question: "Q?",
            executionPosture: "continue",
            idempotencyKey: "eq-arch-req",
          }),
          [T.architectureReviewCancel]: service.architectureReviewCancel(archScope, {
            reviewId: reviewOpen.reviewId,
            reason: "stale",
            idempotencyKey: "eq-cancel-arch",
          }),
        });

        yield* checkRole("coordinator", coordScope, {
          [T.capabilities]: service.capabilities(coordScope),
          [T.delegateTask]: service.delegateTask(coordScope, delegateInputFor("eq-coord-delegate")),
          [T.sendToTask]: service.sendToTask(coordScope, {
            taskId: childId,
            idempotencyKey: "eq-coord-send",
            message: "hi",
          }),
          [T.taskList]: service.taskList(coordScope, { limit: 10 }),
          [T.taskSearch]: service.taskSearch(coordScope, { query: "widget" }),
          [T.taskSummaryHistory]: service.taskSummaryHistory(coordScope, {}),
          [T.taskRead]: service.taskRead(coordScope, { taskId: childId }),
          [T.taskStatus]: service.taskStatus(coordScope, childId),
          [T.taskWait]: service.taskWait(coordScope, childId, 1),
          [T.taskCancel]: service.taskCancel(coordScope, childId),
          [T.switchProvider]: service.switchProvider(coordScope, {
            taskId: coordinatorId,
            target: { providerInstanceId, driverKind: eqDriverKind, model: "gpt-test" },
            reason: "limit",
          }),
          [T.boardCreateCard]: service.boardCreateCard(coordScope, {
            title: "Card C",
            body: "Body C",
            executorRole: "implementation",
          }),
          [T.boardUpdateCard]: service.boardUpdateCard(coordScope, {
            cardId: cardA.cardId,
            title: "Card A2",
          }),
          [T.boardDeleteCard]: service.boardDeleteCard(coordScope, { cardId: cardB.cardId }),
          [T.boardListCards]: service.boardListCards(coordScope, {}),
          [T.architectCreateOrGet]: service.architectCreateOrGet(coordScope, {
            coordinatorThreadId: coordinatorId,
            taskEffort: "low",
            idempotencyKey: "eq-bind",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectureReviewRequest]: service.architectureReviewRequest(coordScope, {
            coordinatorThreadId: coordinatorId,
            reason: "direct-advice",
            question: "Another?",
            executionPosture: "continue",
            idempotencyKey: "eq-req-d",
          }),
          [T.architectureReviewAnswer]: service.architectureReviewAnswer(coordScope, {
            reviewId: reviewOpen.reviewId,
            disposition: "recommendation",
            summary: "nope",
            idempotencyKey: "eq-ans-coord",
          }),
          [T.prepareCoordinatorPublication]: service.prepareCoordinatorPublication(coordScope, {
            summary: "Advice.",
            disposition: "recommendation",
            executionPosture: "continue",
            idempotencyKey: "eq-prep-coord",
          }),
          [T.publishToCoordinator]: service.publishToCoordinator(coordScope, {
            reviewId: reviewAnswered.reviewId,
            idempotencyKey: "eq-pub-coord",
          }),
          [T.getCoordinatorBinding]: service.getCoordinatorBinding(coordScope, {
            coordinatorThreadId: coordinatorId,
          }),
          [T.listArchitectureReviews]: service.listArchitectureReviews(coordScope, {
            coordinatorThreadId: coordinatorId,
          }),
          [T.architectureReviewCancel]: service.architectureReviewCancel(coordScope, {
            reviewId: reviewCancelTarget.reviewId,
            reason: "stale",
            idempotencyKey: "eq-cancel-coord",
          }),
          [T.architectReplace]: service.architectReplace(coordScope, {
            coordinatorThreadId: coordinatorId,
            taskEffort: "low",
            reason: "stale",
            idempotencyKey: "eq-replace",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectDetach]: service.architectDetach(coordScope, {
            coordinatorThreadId: coordinatorId,
            reason: "done",
            idempotencyKey: "eq-detach-coord",
          }),
        });

        yield* checkRole("chat", chatScope, {
          [T.capabilities]: service.capabilities(chatScope),
          [T.delegateTask]: service.delegateTask(chatScope, delegateInputFor("eq-chat-delegate")),
          [T.sendToTask]: service.sendToTask(chatScope, {
            taskId: childId,
            idempotencyKey: "eq-chat-send",
            message: "hi",
          }),
          [T.taskList]: service.taskList(chatScope, { limit: 10 }),
          [T.taskSearch]: service.taskSearch(chatScope, { query: "widget" }),
          [T.taskSummaryHistory]: service.taskSummaryHistory(chatScope, {}),
          [T.taskRead]: service.taskRead(chatScope, { taskId: childId }),
          [T.taskStatus]: service.taskStatus(chatScope, childId),
          [T.taskWait]: service.taskWait(chatScope, childId, 1),
          [T.taskCancel]: service.taskCancel(chatScope, childId),
          [T.switchProvider]: service.switchProvider(chatScope, {
            taskId: chatId,
            target: { providerInstanceId, driverKind: eqDriverKind, model: "gpt-test" },
            reason: "limit",
          }),
          [T.boardCreateCard]: service.boardCreateCard(chatScope, {
            title: "x",
            body: "y",
            executorRole: "implementation",
          }),
          [T.boardUpdateCard]: service.boardUpdateCard(chatScope, {
            cardId: bogusCard,
            title: "x",
          }),
          [T.boardDeleteCard]: service.boardDeleteCard(chatScope, { cardId: bogusCard }),
          [T.boardListCards]: service.boardListCards(chatScope, {}),
          [T.architectCreateOrGet]: service.architectCreateOrGet(chatScope, {
            coordinatorThreadId: chatId,
            taskEffort: "low",
            idempotencyKey: "eq-chat-bind",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectReplace]: service.architectReplace(chatScope, {
            coordinatorThreadId: chatId,
            taskEffort: "low",
            reason: "stale",
            idempotencyKey: "eq-chat-replace",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectDetach]: service.architectDetach(chatScope, {
            coordinatorThreadId: chatId,
            reason: "done",
            idempotencyKey: "eq-detach-chat",
          }),
          [T.architectureReviewRequest]: service.architectureReviewRequest(chatScope, {
            coordinatorThreadId: chatId,
            reason: "direct-advice",
            question: "Q?",
            executionPosture: "continue",
            idempotencyKey: "eq-chat-req",
          }),
          [T.architectureReviewAnswer]: service.architectureReviewAnswer(chatScope, {
            reviewId: reviewOpen.reviewId,
            disposition: "recommendation",
            summary: "nope",
            idempotencyKey: "eq-ans-chat",
          }),
          [T.prepareCoordinatorPublication]: service.prepareCoordinatorPublication(chatScope, {
            summary: "Advice.",
            disposition: "recommendation",
            executionPosture: "continue",
            idempotencyKey: "eq-prep-chat",
          }),
          [T.publishToCoordinator]: service.publishToCoordinator(chatScope, {
            reviewId: bogusReview,
            idempotencyKey: "eq-pub-chat",
          }),
          [T.getCoordinatorBinding]: service.getCoordinatorBinding(chatScope, {
            coordinatorThreadId: chatId,
          }),
          [T.listArchitectureReviews]: service.listArchitectureReviews(chatScope, {
            coordinatorThreadId: chatId,
          }),
          [T.architectureReviewCancel]: service.architectureReviewCancel(chatScope, {
            reviewId: bogusReview,
            reason: "stale",
            idempotencyKey: "eq-cancel-chat",
          }),
        });

        yield* checkRole("executor", execScope, {
          [T.capabilities]: service.capabilities(execScope),
          [T.delegateTask]: service.delegateTask(execScope, delegateInputFor("eq-exec-delegate")),
          [T.sendToTask]: service.sendToTask(execScope, {
            taskId: childId,
            idempotencyKey: "eq-exec-send",
            message: "hi",
          }),
          [T.taskList]: service.taskList(execScope, { limit: 10 }),
          [T.taskSearch]: service.taskSearch(execScope, { query: "widget" }),
          [T.taskSummaryHistory]: service.taskSummaryHistory(execScope, {}),
          [T.taskRead]: service.taskRead(execScope, { taskId: childId }),
          [T.taskStatus]: service.taskStatus(execScope, childId),
          [T.taskWait]: service.taskWait(execScope, childId, 1),
          [T.taskCancel]: service.taskCancel(execScope, childId),
          [T.switchProvider]: service.switchProvider(execScope, {
            taskId: executorId,
            target: { providerInstanceId, driverKind: eqDriverKind, model: "gpt-test" },
            reason: "limit",
          }),
          [T.boardCreateCard]: service.boardCreateCard(execScope, {
            title: "x",
            body: "y",
            executorRole: "implementation",
          }),
          [T.boardUpdateCard]: service.boardUpdateCard(execScope, {
            cardId: bogusCard,
            title: "x",
          }),
          [T.boardDeleteCard]: service.boardDeleteCard(execScope, { cardId: bogusCard }),
          [T.boardListCards]: service.boardListCards(execScope, {}),
          [T.architectCreateOrGet]: service.architectCreateOrGet(execScope, {
            coordinatorThreadId: executorId,
            taskEffort: "low",
            idempotencyKey: "eq-exec-bind",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectReplace]: service.architectReplace(execScope, {
            coordinatorThreadId: executorId,
            taskEffort: "low",
            reason: "stale",
            idempotencyKey: "eq-exec-replace",
            modelSelection: architectModelSelection,
            routingEvidence: architectRoutingEvidence("low"),
          }),
          [T.architectDetach]: service.architectDetach(execScope, {
            coordinatorThreadId: executorId,
            reason: "done",
            idempotencyKey: "eq-detach-exec",
          }),
          [T.architectureReviewRequest]: service.architectureReviewRequest(execScope, {
            coordinatorThreadId: executorId,
            reason: "direct-advice",
            question: "Q?",
            executionPosture: "continue",
            idempotencyKey: "eq-exec-req",
          }),
          [T.architectureReviewAnswer]: service.architectureReviewAnswer(execScope, {
            reviewId: reviewOpen.reviewId,
            disposition: "recommendation",
            summary: "nope",
            idempotencyKey: "eq-ans-exec",
          }),
          [T.prepareCoordinatorPublication]: service.prepareCoordinatorPublication(execScope, {
            summary: "Advice.",
            disposition: "recommendation",
            executionPosture: "continue",
            idempotencyKey: "eq-prep-exec",
          }),
          [T.publishToCoordinator]: service.publishToCoordinator(execScope, {
            reviewId: reviewAnswered.reviewId,
            idempotencyKey: "eq-pub-exec",
          }),
          [T.getCoordinatorBinding]: service.getCoordinatorBinding(execScope, {
            coordinatorThreadId: coordinatorId,
          }),
          [T.listArchitectureReviews]: service.listArchitectureReviews(execScope, {
            coordinatorThreadId: coordinatorId,
          }),
          [T.architectureReviewCancel]: service.architectureReviewCancel(execScope, {
            reviewId: reviewOpen.reviewId,
            reason: "stale",
            idempotencyKey: "eq-cancel-exec",
          }),
        });
      }),
    ),
  );

  it.effect("keeps ordinary-chat delegation working and the board hidden", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const harness = makeEqHarness(store);
        const chatScope = scopeFor(chatId, FULL_CAPS);
        const visible = yield* resolveVisibleTools(chatScope).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(BoardRepository, {
                listOrchestrators: () =>
                  Effect.succeed([
                    { threadId: coordinatorId, createdBy: "human" as const, createdAt: eqNow },
                  ]),
              } as unknown as BoardRepositoryShape),
              Layer.succeed(ProjectionSnapshotQuery, {
                getThreadShellById: (threadId: ThreadId) =>
                  Effect.succeed(Option.some(eqShellFor(harness.threads.get(threadId)!))),
              } as unknown as ProjectionSnapshotQueryShape),
              Layer.succeed(CoordinatorArchitectRepository, store),
            ),
          ),
        );
        const core = [
          T.capabilities,
          T.delegateTask,
          T.sendToTask,
          T.taskList,
          T.taskSearch,
          T.taskSummaryHistory,
          T.taskRead,
          T.taskStatus,
          T.taskWait,
          T.taskCancel,
          T.switchProvider,
        ];
        for (const toolName of core) assert.isTrue(visible.has(toolName), toolName);
        for (const toolName of [
          T.boardCreateCard,
          T.boardUpdateCard,
          T.boardDeleteCard,
          T.boardListCards,
        ]) {
          assert.isFalse(visible.has(toolName), toolName);
        }
        const outcome = yield* classify(
          harness.service.delegateTask(chatScope, {
            idempotencyKey: "eq-chat-delegate-kept",
            title: "Implement widget",
            prompt: "Implement the accepted widget contract.",
            role: "implementation" as const,
            target: {
              providerInstanceId,
              driverKind: eqDriverKind,
              model: "gpt-test",
              options: [{ id: "effort", value: "high" }],
            },
            runtimeMode: "approval-required" as const,
            interactionMode: "default" as const,
          }),
        );
        assert.isTrue(outcome !== "denied", `delegate_task denied: ${outcome}`);
      }),
    ),
  );
});
