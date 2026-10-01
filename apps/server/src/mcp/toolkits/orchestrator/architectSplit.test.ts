import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  BoardCardId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATOR_MCP_TASK_PAGE_MAX,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  OrchestratorMcpFailure,
  type OrchestratorMcpArchitectCreateOrGetInput,
  type ArchitectureReviewRecord,
  type CoordinatorArchitectBinding,
  type CoordinatorArchitectRoutingEvidence,
  type ModelSelection,
  type OrchestratorMcpArchitectCreateOrGetResult,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import type { DelegatedTaskMemoryRow } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandIdConflictError } from "../../../orchestration/Errors.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import type { BoardRepositoryShape } from "../../../persistence/Services/Board.ts";

import {
  CoordinatorArchitectIdempotencyConflict,
  CoordinatorArchitectRepository,
  type CoordinatorArchitectRepositoryShape,
} from "../../../persistence/Services/CoordinatorArchitect.ts";
import { CoordinatorArchitectRepositoryLive } from "../../../persistence/Layers/CoordinatorArchitect.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  publishWakeReviewIdFromMessageId,
  REVIEW_WAKE_DELIVERED_ACTIVITY,
  reviewWakeDeliveredMarkerId,
  reviewWakeReviewIdFromMessageId,
} from "../../../orchestration/coordinatorArchitect.ts";
import { __testing, type OrchestratorMcpDependencies } from "./service.ts";

const now = "2026-09-28T12:00:00.000Z";
const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("codex");
const providerSessionId = "provider-session-1";
const coordinatorId = ThreadId.make("coordinator-1");
const otherCoordinatorId = ThreadId.make("coordinator-2");
const architectModelSelection: ModelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: "max" }],
};

const architectRoutingEvidence = (
  taskEffort: OrchestratorMcpArchitectCreateOrGetInput["taskEffort"],
): CoordinatorArchitectRoutingEvidence => ({
  policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10",
  policyRevision: 10,
  role: "architecture",
  taskEffort,
  consideredCandidates: [
    {
      alias: "L",
      providerInstanceId,
      driverKind,
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "max" }],
      disposition: "selected",
      reason: "First eligible target in the architecture effort cell.",
    },
  ],
});

function threadDetail(
  id: ThreadId,
  overrides: {
    readonly delegationParent?: { readonly taskId: ThreadId } | null;
    readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
    readonly idle?: boolean;
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
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    session:
      overrides.idle === true
        ? null
        : {
            threadId: id,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: TurnId.make(`${id}-turn`),
            lastError: null,
            updatedAt: now,
          },
    messages: [],
    activities: [...(overrides.activities ?? [])],
    checkpoints: [],
    proposedPlans: [],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...(overrides.delegationParent === undefined
      ? {}
      : { delegationParent: overrides.delegationParent }),
  } as OrchestrationThread;
}

function lineageActivity(childId: ThreadId, parentId: ThreadId): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${childId}-lineage`),
    tone: "info",
    kind: "delegation.created",
    summary: "Delegated child created",
    payload: {
      version: 1,
      taskId: childId,
      childThreadId: childId,
      parentEnvironmentId: environmentId,
      parentThreadId: parentId,
      parentTurnId: `${parentId}-turn`,
      projectId,
      delegatedMessageId: MessageId.make(`${childId}-request`),
      callerRequestFingerprint: "fp-caller",
      requestFingerprint: "fp-request",
      requestedAt: now,
      role: "implementation",
      workspaceRoot: "/workspace",
      worktreePath: `/workspace/${childId}`,
      requested: {},
    },
    turnId: null,
    createdAt: now,
  } as OrchestrationThreadActivity;
}

function markerActivity(id: string, kind: string, reviewId: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload: { reviewId },
    turnId: null,
    createdAt: now,
  } as OrchestrationThreadActivity;
}

function scopeFor(
  threadId: ThreadId,
  controlPlaneRole?: McpInvocationScope["controlPlaneRole"],
): McpInvocationScope {
  return {
    environmentId,
    threadId,
    providerSessionId,
    providerInstanceId,
    capabilities: new Set(["orchestration"] as const),
    orchestration: {
      projectId,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      workspaceRoot: "/workspace",
      worktreePath: `/workspace/${threadId}`,
      permissionEnvelope: {
        status: "verified",
        fingerprint: "a".repeat(64),
        filesystem: "unrestricted",
        externalDirectories: "unrestricted",
        commandExecution: "unrestricted",
        network: "unrestricted",
        approvalBypass: true,
        providerTools: [],
        externalTools: [],
        t3McpCapabilities: ["orchestration", "device", "preview", "pull-requests"],
      },
    },
    issuedAt: 1,
    ...(controlPlaneRole === undefined ? {} : { controlPlaneRole }),
  };
}

interface MemoryBindingRow extends CoordinatorArchitectBinding {
  createRequestFingerprint: string;
  closeIdempotencyKey: string | null;
  closeRequestFingerprint: string | null;
}

function makeMemoryStore(): CoordinatorArchitectRepositoryShape & {
  readonly bindings: Map<string, MemoryBindingRow>;
  readonly reviews: Map<string, ArchitectureReviewRecord>;
} {
  const bindings = new Map<string, MemoryBindingRow>();
  const reviews = new Map<string, ArchitectureReviewRecord>();
  const activeFor = (coordinatorThreadId: string): MemoryBindingRow | null => {
    for (const row of bindings.values()) {
      if (row.coordinatorThreadId === coordinatorThreadId && row.status === "active") return row;
    }
    return null;
  };
  return {
    bindings,
    reviews,
    createOrGetBinding: (input) =>
      Effect.gen(function* () {
        for (const row of bindings.values()) {
          if (
            row.coordinatorThreadId === input.coordinatorThreadId &&
            row.createIdempotencyKey === input.createIdempotencyKey
          ) {
            if (row.createRequestFingerprint !== input.createRequestFingerprint) {
              return yield* new CoordinatorArchitectIdempotencyConflict({
                operation: "createOrGetBinding",
                existingId: row.bindingId,
              });
            }
            if (row.status === "active") return { binding: row, created: false };
            return {
              binding: activeFor(input.coordinatorThreadId) ?? row,
              created: false,
            };
          }
        }
        const existing = activeFor(input.coordinatorThreadId);
        if (existing !== null) return { binding: existing, created: false };
        const row: MemoryBindingRow = {
          bindingId: input.bindingId,
          coordinatorThreadId: ThreadId.make(input.coordinatorThreadId),
          architectThreadId: ThreadId.make(input.architectThreadId),
          projectId: ProjectId.make(input.projectId),
          architectTaskEffort: input.architectTaskEffort,
          status: "active",
          createdAt: input.createdAt,
          createdBy: ThreadId.make(input.createdBy),
          replacedByBindingId: null,
          detachReason: null,
          createIdempotencyKey: input.createIdempotencyKey,
          createRequestFingerprint: input.createRequestFingerprint,
          closeIdempotencyKey: null,
          closeRequestFingerprint: null,
          routingEvidence: input.routingEvidence,
        };
        bindings.set(row.bindingId, row);
        return { binding: row, created: true };
      }),
    getActiveBindingByCoordinator: (coordinatorThreadId) =>
      Effect.succeed(activeFor(coordinatorThreadId)),
    getActiveBindingByArchitect: (architectThreadId) => {
      for (const row of bindings.values()) {
        if (row.architectThreadId === architectThreadId && row.status === "active") {
          return Effect.succeed<MemoryBindingRow | null>(row);
        }
      }
      return Effect.succeed<MemoryBindingRow | null>(null);
    },
    getBindingById: (bindingId) => Effect.succeed(bindings.get(bindingId) ?? null),
    getAnyBindingByArchitect: (architectThreadId) => {
      let latest: MemoryBindingRow | null = null;
      for (const row of bindings.values()) {
        if (row.architectThreadId === architectThreadId) latest = row;
      }
      return Effect.succeed(latest);
    },
    listActiveBindings: () =>
      Effect.succeed([...bindings.values()].filter((row) => row.status === "active")),
    findBindingByCreateKey: (input) => {
      for (const row of bindings.values()) {
        if (
          row.coordinatorThreadId === input.coordinatorThreadId &&
          row.createIdempotencyKey === input.createIdempotencyKey
        ) {
          return Effect.succeed<MemoryBindingRow | null>(row);
        }
      }
      return Effect.succeed<MemoryBindingRow | null>(null);
    },
    findDetachReplay: (input) => {
      for (const row of bindings.values()) {
        if (
          row.coordinatorThreadId === input.coordinatorThreadId &&
          row.status === "detached" &&
          row.closeIdempotencyKey === input.closeIdempotencyKey
        ) {
          if (row.closeRequestFingerprint !== input.closeRequestFingerprint) {
            return Effect.fail(
              new CoordinatorArchitectIdempotencyConflict({
                operation: "findDetachReplay",
                existingId: row.bindingId,
              }),
            );
          }
          return Effect.succeed<MemoryBindingRow | null>(row);
        }
      }
      return Effect.succeed<MemoryBindingRow | null>(null);
    },
    findReplaceReplay: (input) => {
      for (const row of bindings.values()) {
        if (
          row.coordinatorThreadId === input.coordinatorThreadId &&
          row.status === "replaced" &&
          row.closeIdempotencyKey === input.closeIdempotencyKey
        ) {
          if (row.closeRequestFingerprint !== input.closeRequestFingerprint) {
            return Effect.fail(
              new CoordinatorArchitectIdempotencyConflict({
                operation: "findReplaceReplay",
                existingId: row.bindingId,
              }),
            );
          }
          return Effect.succeed<MemoryBindingRow | null>(row);
        }
      }
      return Effect.succeed<MemoryBindingRow | null>(null);
    },
    closeBinding: (input) => {
      const row = bindings.get(input.bindingId) ?? null;
      if (row === null) return Effect.succeed(null);
      if (row.status !== "active") return Effect.succeed(row);
      const closed: MemoryBindingRow = {
        ...row,
        status: input.status,
        replacedByBindingId: input.replacedByBindingId,
        detachReason: input.detachReason,
        closeIdempotencyKey: input.idempotencyKey,
        closeRequestFingerprint: input.closeRequestFingerprint,
      };
      bindings.set(closed.bindingId, closed);
      return Effect.succeed(closed);
    },
    linkReplacementWinner: (input) => {
      const replaced = bindings.get(input.replacedBindingId);
      const winner = bindings.get(input.winnerBindingId);
      if (
        replaced === undefined ||
        replaced.status !== "replaced" ||
        replaced.closeIdempotencyKey !== input.closeIdempotencyKey
      ) {
        return Effect.succeed<MemoryBindingRow | null>(null);
      }
      if (replaced.closeRequestFingerprint !== input.closeRequestFingerprint) {
        return Effect.fail(
          new CoordinatorArchitectIdempotencyConflict({
            operation: "linkReplacementWinner",
            existingId: replaced.bindingId,
          }),
        );
      }
      if (winner === undefined || winner.coordinatorThreadId !== replaced.coordinatorThreadId) {
        return Effect.succeed<MemoryBindingRow | null>(null);
      }
      const linked = { ...replaced, replacedByBindingId: winner.bindingId };
      bindings.set(linked.bindingId, linked);
      return Effect.succeed<MemoryBindingRow | null>(linked);
    },
    listBindingsByCoordinator: (coordinatorThreadId) =>
      Effect.succeed(
        [...bindings.values()].filter((row) => row.coordinatorThreadId === coordinatorThreadId),
      ),
    insertReview: (input) => {
      for (const row of reviews.values()) {
        if (
          row.coordinatorThreadId === input.coordinatorThreadId &&
          row.requestIdempotencyKey === input.requestIdempotencyKey
        ) {
          return Effect.succeed({ review: row, created: false });
        }
      }
      const row: ArchitectureReviewRecord = {
        reviewId: input.reviewId,
        bindingId: input.bindingId,
        coordinatorThreadId: ThreadId.make(input.coordinatorThreadId),
        architectThreadId: ThreadId.make(input.architectThreadId),
        subjectChildThreadId:
          input.subjectChildThreadId === null ? null : ThreadId.make(input.subjectChildThreadId),
        reason: input.reason,
        question: input.question,
        refs: input.refs,
        executionPosture: input.executionPosture,
        answerDisposition: null,
        status: "open",
        answerSummary: null,
        requestIdempotencyKey: input.requestIdempotencyKey,
        answerIdempotencyKey: null,
        answerPayloadFingerprint: null,
        publishIdempotencyKey: null,
        cancelIdempotencyKey: null,
        cancelledAt: null,
        cancelledBy: null,
        createdAt: input.createdAt,
        answeredAt: null,
        publishedAt: null,
        publishDeliveredAt: null,
        lastPublishFailure: null,
      };
      reviews.set(row.reviewId, row);
      return Effect.succeed({ review: row, created: true });
    },
    getReviewById: (reviewId) => Effect.succeed(reviews.get(reviewId) ?? null),
    getReviewByRequestKey: (input) => {
      for (const row of reviews.values()) {
        if (
          row.coordinatorThreadId === input.coordinatorThreadId &&
          row.requestIdempotencyKey === input.requestIdempotencyKey
        ) {
          return Effect.succeed(row);
        }
      }
      return Effect.succeed(null);
    },
    listReviewsByCoordinator: (input) =>
      Effect.succeed(
        [...reviews.values()].filter(
          (row) =>
            row.coordinatorThreadId === input.coordinatorThreadId &&
            (input.status === undefined || row.status === input.status),
        ),
      ),
    answerReview: (input) => {
      const row = reviews.get(input.reviewId);
      if (row === undefined) return Effect.succeed({ _tag: "state" } as const);
      if (row.status === "answered") {
        if (row.answerIdempotencyKey !== input.answerIdempotencyKey) {
          return Effect.succeed({ _tag: "conflict" } as const);
        }
        return Effect.succeed(
          row.answerPayloadFingerprint === input.answerPayloadFingerprint
            ? ({ _tag: "replay" } as const)
            : ({ _tag: "conflict" } as const),
        );
      }
      if (row.status !== "open") return Effect.succeed({ _tag: "state" } as const);
      reviews.set(input.reviewId, {
        ...row,
        status: "answered",
        refs: { ...row.refs, architectOclRefs: [...input.oclRefs] },
        answerDisposition: input.disposition,
        answerSummary: input.summary,
        answerIdempotencyKey: input.answerIdempotencyKey,
        answerPayloadFingerprint: input.answerPayloadFingerprint,
        answeredAt: input.answeredAt,
      });
      return Effect.succeed({ _tag: "applied" } as const);
    },
    publishReview: (input) => {
      const row = reviews.get(input.reviewId);
      if (row === undefined) return Effect.succeed({ _tag: "state" } as const);
      if (row.status === "published") {
        return Effect.succeed(
          row.publishIdempotencyKey === input.publishIdempotencyKey
            ? ({ _tag: "replay" } as const)
            : ({ _tag: "conflict" } as const),
        );
      }
      if (row.status !== "answered") return Effect.succeed({ _tag: "state" } as const);
      reviews.set(input.reviewId, {
        ...row,
        status: "published",
        publishIdempotencyKey: input.publishIdempotencyKey,
        publishedAt: input.publishedAt,
      });
      return Effect.succeed({ _tag: "applied" } as const);
    },
    markPublishDelivered: (input) => {
      const row = reviews.get(input.reviewId);
      if (row === undefined) return Effect.succeed(undefined);
      reviews.set(input.reviewId, {
        ...row,
        publishDeliveredAt: input.deliveredAt,
        lastPublishFailure: null,
      });
      return Effect.succeed(undefined);
    },
    recordPublishFailure: (input) => {
      const row = reviews.get(input.reviewId);
      if (row === undefined) return Effect.succeed(undefined);
      reviews.set(input.reviewId, {
        ...row,
        lastPublishFailure: {
          reason: input.reason,
          message: input.message,
          attemptedAt: input.attemptedAt,
        },
      });
      return Effect.succeed(undefined);
    },
    cancelReview: (input) => {
      const row = reviews.get(input.reviewId);
      if (row === undefined) return Effect.succeed({ _tag: "state" } as const);
      if (row.status === "cancelled") {
        return Effect.succeed(
          row.cancelIdempotencyKey === input.cancelIdempotencyKey
            ? ({ _tag: "replay" } as const)
            : ({ _tag: "state" } as const),
        );
      }
      if (row.status !== "open" && row.status !== "answered") {
        return Effect.succeed({ _tag: "state" } as const);
      }
      reviews.set(input.reviewId, {
        ...row,
        status: "cancelled",
        cancelIdempotencyKey: input.cancelIdempotencyKey,
        cancelledAt: input.cancelledAt,
        cancelledBy: input.cancelledBy as ArchitectureReviewRecord["cancelledBy"],
      });
      return Effect.succeed({ _tag: "applied" } as const);
    },
  };
}

interface Harness {
  readonly service: Omit<ReturnType<typeof __testing.makeService>, "architectCreateOrGet"> & {
    readonly architectCreateOrGet: (
      scope: McpInvocationScope,
      input: Omit<OrchestratorMcpArchitectCreateOrGetInput, "modelSelection" | "routingEvidence"> &
        Partial<
          Pick<OrchestratorMcpArchitectCreateOrGetInput, "modelSelection" | "routingEvidence">
        >,
    ) => Effect.Effect<OrchestratorMcpArchitectCreateOrGetResult, OrchestratorMcpFailure>;
  };
  readonly dispatched: Array<Record<string, unknown>>;
  readonly threads: Map<ThreadId, OrchestrationThread>;
  readonly revoked: Array<ThreadId>;
  readonly store: CoordinatorArchitectRepositoryShape;
  readonly memoryStore: ReturnType<typeof makeMemoryStore> | null;
  readonly memoryRows: Array<DelegatedTaskMemoryRow & { readonly parentThreadId: ThreadId }>;
  readonly setFlag: (enabled: boolean) => void;
  readonly setDispatchFailure: (
    predicate: ((command: Readonly<Record<string, unknown>>) => boolean) | null,
  ) => void;
}

function makeHarness(
  storeOverride?: CoordinatorArchitectRepositoryShape,
  boardOverride?: BoardRepositoryShape,
  enforceCommandThreadOwnership = false,
): Harness {
  const dispatched: Array<Record<string, unknown>> = [];
  const commandReceipts = new Map<
    string,
    {
      readonly sequence: number;
      readonly aggregateKind: "thread" | "project";
      readonly aggregateId: string;
    }
  >();
  const threads = new Map<ThreadId, OrchestrationThread>();
  const revoked: Array<ThreadId> = [];
  const memoryStore = storeOverride === undefined ? makeMemoryStore() : null;
  const store = storeOverride ?? memoryStore!;
  const memoryRows: Harness["memoryRows"] = [];
  const settingsCell = { flag: true };
  const dispatchFailure = {
    predicate: null as ((command: Readonly<Record<string, unknown>>) => boolean) | null,
  };
  threads.set(coordinatorId, threadDetail(coordinatorId));
  threads.set(otherCoordinatorId, threadDetail(otherCoordinatorId));

  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  } as OrchestrationProjectShell;

  const dependencies: OrchestratorMcpDependencies = {
    dispatch: (command) =>
      Effect.suspend(() => {
        const record = command as Readonly<Record<string, unknown>>;
        const previousReceipt = commandReceipts.get(command.commandId);
        const aggregateKind = "threadId" in command ? "thread" : "project";
        const aggregateId = "threadId" in command ? command.threadId : command.projectId;
        if (
          enforceCommandThreadOwnership &&
          previousReceipt !== undefined &&
          aggregateKind === "thread" &&
          previousReceipt.aggregateKind === "thread" &&
          previousReceipt.aggregateId !== aggregateId
        ) {
          return Effect.fail(
            new OrchestrationCommandIdConflictError({
              commandId: command.commandId,
              receiptAggregateKind: "thread",
              receiptAggregateId: previousReceipt.aggregateId,
              commandAggregateKind: "thread",
              commandAggregateId: aggregateId,
            }),
          );
        }
        if (dispatchFailure.predicate?.(record) === true) {
          return Effect.fail(new Error("injected dispatch crash") as never);
        }
        return Effect.gen(function* () {
          const commandId = command.commandId;
          const previousReceipt = commandReceipts.get(commandId);
          if (previousReceipt !== undefined) return { sequence: previousReceipt.sequence };
          dispatched.push(record as Record<string, unknown>);
          if (command.type === "thread.create") {
            if (!threads.has(command.threadId)) {
              threads.set(command.threadId, threadDetail(command.threadId));
            }
          } else if (command.type === "thread.delete") {
            const thread = threads.get(command.threadId);
            if (thread !== undefined) {
              threads.set(thread.id, { ...thread, deletedAt: now });
            }
          } else if (command.type === "thread.activity.append") {
            const thread = threads.get(command.threadId);
            if (
              thread !== undefined &&
              !thread.activities.some(({ id }) => id === command.activity.id)
            ) {
              threads.set(thread.id, {
                ...thread,
                activities: [...thread.activities, command.activity],
              });
            }
          } else if (command.type === "thread.turn.start") {
            const thread = threads.get(command.threadId);
            if (thread !== undefined) {
              const exists = thread.messages.some(
                (message) => message.id === command.message.messageId,
              );
              threads.set(thread.id, {
                ...thread,
                messages: exists
                  ? thread.messages
                  : [
                      ...thread.messages,
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
              });
            }
            // Stand-in for the provider reactor's confirmed send: in
            // production the review row is marked delivered only after
            // `sendTurn` resolves, never by the service at dispatch time.
            const reviewId = publishWakeReviewIdFromMessageId(String(command.message.messageId));
            if (reviewId !== null) {
              yield* store
                .markPublishDelivered({
                  reviewId,
                  deliveredAt: command.createdAt,
                })
                .pipe(Effect.orDie);
            }
            // Stand-in for the provider reactor's post-send Architect marker.
            const architectReviewId = reviewWakeReviewIdFromMessageId(
              String(command.message.messageId),
              String(command.threadId),
            );
            if (architectReviewId !== null) {
              const markerId = reviewWakeDeliveredMarkerId(
                String(command.threadId),
                architectReviewId,
              );
              yield* dependencies
                .dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(markerId),
                  threadId: command.threadId,
                  activity: {
                    id: EventId.make(markerId),
                    tone: "info",
                    kind: REVIEW_WAKE_DELIVERED_ACTIVITY,
                    summary: "Architect review wake delivered",
                    payload: { reviewId: architectReviewId },
                    turnId: null,
                    createdAt: command.createdAt,
                  },
                  createdAt: command.createdAt,
                })
                .pipe(Effect.orDie);
            }
          }
          const sequence = dispatched.length;
          commandReceipts.set(commandId, { sequence, aggregateKind, aggregateId });
          return { sequence };
        });
      }),
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    getThreadShellById: (threadId) =>
      Effect.succeed(
        Option.map(
          fromNullable(threads.get(threadId)?.deletedAt === null ? threads.get(threadId) : null),
          shellFor,
        ),
      ),
    getProjectShellById: () => Effect.succeed(Option.some(project)),
    getThreadDetailById: (threadId) =>
      Effect.succeed(
        fromNullable(threads.get(threadId)?.deletedAt === null ? threads.get(threadId) : null),
      ),
    listTurnsByThreadId: () => Effect.succeed([] as Array<ProjectionTurn>),
    getProviders: Effect.succeed([
      {
        instanceId: providerInstanceId,
        driver: driverKind,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: now,
        models: [
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
    loadPermissionEnvelope: () =>
      Effect.succeed({
        status: "verified" as const,
        fingerprint: "b".repeat(64),
        filesystem: "read-only" as const,
        externalDirectories: "none" as const,
        commandExecution: "none" as const,
        network: "approval-required" as const,
        approvalBypass: false,
        providerTools: [],
        externalTools: [],
        t3McpCapabilities: ["orchestration"],
      }),
    listDelegatedTaskMemoryRows: ({ parentThreadId: requestedParentThreadId }) =>
      Effect.succeed({
        rows: memoryRows.filter((row) => row.parentThreadId === requestedParentThreadId),
        hasMore: false,
      }),
    getSettings: Effect.sync(() => ({
      ...DEFAULT_SERVER_SETTINGS,
      coordinatorArchitectSplit: settingsCell.flag,
    })),
    now: Effect.succeed(now),
    coordinatorArchitect: store,
    getArchitectCreateReceiptStatus: (bindingId) =>
      Effect.succeed(commandReceipts.has(`architect-create:${bindingId}`) ? "accepted" : "missing"),
    ...(boardOverride === undefined ? {} : { board: boardOverride }),
    revokeThreadCredential: (threadId) =>
      Effect.sync(() => {
        revoked.push(threadId);
      }),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: [project],
        threads: [...threads.values()].filter((thread) => thread.deletedAt === null).map(shellFor),
        updatedAt: now,
      }),
  };
  return {
    service: (() => {
      const service = __testing.makeService(dependencies);
      return {
        ...service,
        architectCreateOrGet: (scope, input) =>
          service.architectCreateOrGet(scope, {
            ...input,
            modelSelection: input.modelSelection ?? architectModelSelection,
            routingEvidence: input.routingEvidence ?? architectRoutingEvidence(input.taskEffort),
          }),
      };
    })(),
    dispatched,
    threads,
    revoked,
    store,
    memoryStore,
    memoryRows,
    setFlag: (enabled: boolean) => {
      settingsCell.flag = enabled;
    },
    setDispatchFailure: (predicate) => {
      dispatchFailure.predicate = predicate;
    },
  };
}

const fromNullable = <A>(value: A | null | undefined): Option.Option<A> =>
  value === null || value === undefined ? Option.none() : Option.some(value);

const shellFor = (thread: OrchestrationThread): OrchestrationThreadShell =>
  ({
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
  }) as OrchestrationThreadShell;

const failureCodeOf = (error: unknown): string =>
  (error as { readonly code?: unknown }).code === undefined
    ? "no-code"
    : String((error as { readonly code: string }).code);

const runFailure = <A>(effect: Effect.Effect<A, OrchestratorMcpFailure>): Effect.Effect<string> =>
  Effect.matchCauseEffect(effect, {
    onFailure: (cause) => {
      const failureValue = Cause.findErrorOption(cause);
      return Effect.succeed(
        Option.isSome(failureValue) ? failureCodeOf(failureValue.value) : "non-failure-cause",
      );
    },
    onSuccess: () => Effect.succeed("unexpected-success"),
  });

describe("phase 1 coordinator/architect service", () => {
  it.effect("uses the shared contract page limit for server-side search batches", () =>
    Effect.sync(() => {
      assert.strictEqual(__testing.taskSearchBatchSize, ORCHESTRATOR_MCP_TASK_PAGE_MAX);
    }),
  );

  it.effect("creates a binding once and converges repeats on the winner", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const first = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "high",
        idempotencyKey: "create-1",
      });
      assert.isTrue(first.created);
      assert.strictEqual(first.binding.status, "active");
      assert.isTrue(first.architectThreadId.startsWith("arch:"));
      const creates = harness.dispatched.filter((command) => command["type"] === "thread.create");
      assert.strictEqual(creates.length, 1);
      assert.strictEqual(creates[0]?.["commandId"], `architect-create:${first.binding.bindingId}`);
      const bounds = harness.threads.get(coordinatorId)?.activities ?? [];
      assert.isTrue(bounds.some((activity) => activity.kind === "architect.bound"));

      const replay = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "high",
        idempotencyKey: "create-1",
      });
      assert.isFalse(replay.created);
      assert.strictEqual(replay.binding.bindingId, first.binding.bindingId);
      assert.strictEqual(
        harness.dispatched.filter((command) => command["type"] === "thread.create").length,
        1,
      );

      const otherKey = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "low",
        idempotencyKey: "create-2",
      });
      assert.isFalse(otherKey.created);
      assert.strictEqual(otherKey.binding.bindingId, first.binding.bindingId);
    }),
  );

  it.effect("concurrent creates commit one binding, one live Architect, and no loser shell", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const results = yield* Effect.forEach(
        ["parallel-create-a", "parallel-create-b"],
        (idempotencyKey) =>
          harness.service.architectCreateOrGet(scope, {
            coordinatorThreadId: coordinatorId,
            taskEffort: "medium",
            idempotencyKey,
          }),
        { concurrency: 2 },
      );
      assert.strictEqual(new Set(results.map((result) => result.binding.bindingId)).size, 1);
      assert.strictEqual(results.filter((result) => result.created).length, 1);
      assert.strictEqual(
        [...harness.threads.values()].filter(
          (thread) => thread.id.startsWith("arch:") && thread.deletedAt === null,
        ).length,
        1,
      );
      assert.strictEqual(
        harness.dispatched.filter((command) => command["type"] === "thread.create").length,
        1,
      );
      assert.deepStrictEqual(yield* harness.service.reconcileAfterRestart(), []);
    }),
  );

  it.effect("resolves a losing replace to the committed winner and never stores its id", () =>
    Effect.gen(function* () {
      const backing = makeMemoryStore();
      let harnessThreads: Harness["threads"] | undefined;
      let injected = false;
      const winnerBindingId = "binding-parallel-replace-winner";
      const winnerThreadId = ThreadId.make("arch:parallel-replace-winner");
      const store: CoordinatorArchitectRepositoryShape = {
        ...backing,
        createOrGetBinding: (input) =>
          Effect.gen(function* () {
            if (input.createIdempotencyKey === "parallel-replace-loser" && !injected) {
              injected = true;
              const winner = yield* backing.createOrGetBinding({
                bindingId: winnerBindingId,
                coordinatorThreadId: input.coordinatorThreadId,
                architectThreadId: winnerThreadId,
                projectId: input.projectId,
                architectTaskEffort: "high",
                routingEvidence: architectRoutingEvidence("high"),
                createdAt: now,
                createdBy: coordinatorId,
                createIdempotencyKey: "parallel-replace-winner",
                createRequestFingerprint: "parallel-replace-winner-fingerprint",
              });
              harnessThreads?.set(winner.binding.architectThreadId, threadDetail(winnerThreadId));
            }
            return yield* backing.createOrGetBinding(input);
          }),
      };
      const harness = makeHarness(store);
      harnessThreads = harness.threads;
      const scope = scopeFor(coordinatorId);
      const original = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-before-parallel-replace",
      });
      const losingBindingId = __testing.deterministicId(
        "architect-binding",
        coordinatorId,
        "parallel-replace-loser",
      );
      const losingArchitectThreadId = ThreadId.make(
        `arch:${__testing.deterministicId("", "architect-thread", losingBindingId).slice(1)}`,
      );
      harness.threads.set(losingArchitectThreadId, threadDetail(losingArchitectThreadId));
      const loser = yield* harness.service.architectReplace(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "high",
        modelSelection: architectModelSelection,
        routingEvidence: architectRoutingEvidence("high"),
        reason: "Parallel replace winner committed first.",
        idempotencyKey: "parallel-replace-loser",
      });
      assert.strictEqual(loser.binding.bindingId, winnerBindingId);
      assert.strictEqual(harness.threads.get(losingArchitectThreadId)?.deletedAt, now);
      assert.isTrue(
        harness.threads
          .get(coordinatorId)
          ?.activities.some(
            (activity) =>
              activity.id === `architect-unbound-race:${losingBindingId}` &&
              activity.kind === "architect.unbound" &&
              (activity.payload as { readonly reason?: unknown }).reason === "binding-race-lost",
          ),
      );
      const replaced = yield* backing.getBindingById(original.binding.bindingId);
      assert.strictEqual(replaced?.status, "replaced");
      assert.strictEqual(replaced?.replacedByBindingId, winnerBindingId);
      const allBindings = yield* backing.listBindingsByCoordinator(coordinatorId);
      assert.isFalse(
        allBindings.some((binding) => binding.createIdempotencyKey === "parallel-replace-loser"),
      );
      assert.strictEqual(
        [...harness.threads.values()].filter(
          (thread) => thread.id.startsWith("arch:") && thread.deletedAt === null,
        ).length,
        2,
      );
      const outcomes = yield* harness.service.reconcileAfterRestart();
      assert.isTrue(outcomes.some((outcome) => outcome.outcome === "terminal-thread-soft-deleted"));
      assert.strictEqual(
        [...harness.threads.values()].filter(
          (thread) => thread.id.startsWith("arch:") && thread.deletedAt === null,
        ).length,
        1,
      );
    }),
  );

  it.effect(
    "detach reports a typed close race instead of returning its stale active snapshot",
    () =>
      Effect.gen(function* () {
        const backing = makeMemoryStore();
        let injected = false;
        const winnerId = "binding-detach-race-winner";
        const winnerThreadId = ThreadId.make("arch:detach-race-winner");
        const store: CoordinatorArchitectRepositoryShape = {
          ...backing,
          closeBinding: (input) =>
            Effect.gen(function* () {
              if (input.status === "detached" && !injected) {
                injected = true;
                const prior = yield* backing.getBindingById(input.bindingId);
                const replaced = yield* backing.closeBinding({
                  ...input,
                  status: "replaced",
                  replacedByBindingId: null,
                  detachReason: "A concurrent replace committed first.",
                  idempotencyKey: "detach-race-replace-close",
                  closeRequestFingerprint: "detach-race-replace-fingerprint",
                });
                assert.isNotNull(replaced);
                const winner = yield* backing.createOrGetBinding({
                  bindingId: winnerId,
                  coordinatorThreadId: prior?.coordinatorThreadId ?? coordinatorId,
                  architectThreadId: winnerThreadId,
                  projectId: String(projectId),
                  architectTaskEffort: "high",
                  routingEvidence: architectRoutingEvidence("high"),
                  createdAt: now,
                  createdBy: coordinatorId,
                  createIdempotencyKey: "detach-race-replace-create",
                  createRequestFingerprint: "detach-race-replace-create-fingerprint",
                });
                yield* backing.linkReplacementWinner({
                  replacedBindingId: input.bindingId,
                  closeIdempotencyKey: "detach-race-replace-close",
                  closeRequestFingerprint: "detach-race-replace-fingerprint",
                  winnerBindingId: winner.binding.bindingId,
                });
                return null;
              }
              return yield* backing.closeBinding(input);
            }),
        };
        const harness = makeHarness(store);
        const scope = scopeFor(coordinatorId);
        const original = yield* harness.service.architectCreateOrGet(scope, {
          coordinatorThreadId: coordinatorId,
          taskEffort: "medium",
          idempotencyKey: "create-before-detach-race",
        });

        const error = yield* Effect.flip(
          harness.service.architectDetach(scope, {
            coordinatorThreadId: coordinatorId,
            reason: "Detach races a replace.",
            idempotencyKey: "detach-race-loser",
          }),
        );
        assert.instanceOf(error, OrchestratorMcpFailure);
        assert.strictEqual(error.code, "binding_conflict");
        const old = yield* backing.getBindingById(original.binding.bindingId);
        assert.strictEqual(old?.status, "replaced");
        assert.strictEqual(old?.replacedByBindingId, winnerId);
        const visible = yield* harness.service.getCoordinatorBinding(scope, {
          coordinatorThreadId: coordinatorId,
        });
        assert.strictEqual(visible.binding?.bindingId, winnerId);
        assert.strictEqual(visible.binding?.architectThreadId, winnerThreadId);
      }),
  );

  it.effect("replays replacement idempotently and conflicts when its reason changes", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const original = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "high",
        idempotencyKey: "create-before-replace",
      });
      const input = {
        coordinatorThreadId: coordinatorId,
        taskEffort: "high" as const,
        modelSelection: architectModelSelection,
        routingEvidence: architectRoutingEvidence("high"),
        reason: "The current target is no longer suitable.",
        idempotencyKey: "replace-1",
      };
      const replaced = yield* harness.service.architectReplace(scope, input);
      assert.notStrictEqual(replaced.binding.bindingId, original.binding.bindingId);
      assert.strictEqual(replaced.binding.status, "active");
      assert.isTrue(harness.revoked.includes(original.architectThreadId));
      const closed = harness.memoryStore!.bindings.get(original.binding.bindingId);
      assert.strictEqual(closed?.status, "replaced");
      assert.strictEqual(closed?.replacedByBindingId, replaced.binding.bindingId);
      const createCount = harness.dispatched.filter(
        (command) => command["type"] === "thread.create",
      ).length;

      const replay = yield* harness.service.architectReplace(scope, input);
      assert.strictEqual(replay.binding.bindingId, replaced.binding.bindingId);
      assert.strictEqual(
        harness.dispatched.filter((command) => command["type"] === "thread.create").length,
        createCount,
      );
      const stableReplay = yield* harness.service.architectReplace(scope, input);
      assert.strictEqual(stableReplay.binding.bindingId, replaced.binding.bindingId);
      assert.strictEqual(
        harness.dispatched.filter((command) => command["type"] === "thread.create").length,
        createCount,
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectReplace(scope, {
            ...input,
            reason: "Changed under the same key.",
          }),
        ),
        "idempotency_conflict",
      );
    }),
  );

  it.effect("returns a typed routing-evidence mismatch for a different selected model", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const mismatch = yield* Effect.flip(
        harness.service.architectCreateOrGet(scopeFor(coordinatorId), {
          coordinatorThreadId: coordinatorId,
          taskEffort: "high",
          modelSelection: { ...architectModelSelection, model: "unmatched-model" },
          routingEvidence: architectRoutingEvidence("high"),
          idempotencyKey: "bad-route",
        }),
      );
      assert.instanceOf(mismatch, OrchestratorMcpFailure);
      assert.strictEqual(mismatch.code, "routing_evidence_mismatch");
      assert.strictEqual(harness.memoryStore!.bindings.size, 0);
    }),
  );

  it.effect("denies architect callers on execution tools and architect targets", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");

      assert.strictEqual(
        yield* runFailure(
          harness.service.delegateTask(archScope, {
            idempotencyKey: "x",
            title: "x",
            prompt: "x",
            role: "implementation",
            target: {
              providerInstanceId,
              driverKind,
              model: "m",
              options: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ),
        "architect_denied",
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.sendToTask(archScope, {
            taskId: ThreadId.make("task-1"),
            idempotencyKey: "s-1",
            message: "hi",
          }),
        ),
        "architect_denied",
      );
      assert.strictEqual(
        yield* runFailure(harness.service.taskCancel(archScope, ThreadId.make("task-1"))),
        "architect_denied",
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.boardCreateCard(archScope, {
            title: "t",
            body: "b",
            executorRole: "implementation",
          }),
        ),
        "architect_denied",
      );
      // Coordinator tooling resolves an architect-thread id as an executor
      // target with the shared guard instead of leaking it.
      assert.strictEqual(
        yield* runFailure(
          harness.service.sendToTask(scope, {
            taskId: created.architectThreadId,
            idempotencyKey: "s-2",
            message: "hi",
          }),
        ),
        "architect_denied",
      );
    }),
  );

  it.effect("denies MCP board assignment to an Architect before persisting card changes", () =>
    Effect.gen(function* () {
      let updates = 0;
      const cardId = BoardCardId.make("board-card-architect-target");
      const board = {
        listOrchestrators: () =>
          Effect.succeed([{ threadId: coordinatorId, createdBy: "human", createdAt: now }]),
        getCard: () =>
          Effect.succeed(
            Option.some({
              cardId,
              orchestratorThreadId: coordinatorId,
              title: "Review assignment",
              body: "Keep assignment on an executor.",
              status: "todo",
              createdBy: "human",
              assignee: null,
              executorRole: "review",
              executorThreadId: null,
              outcome: null,
              lastError: null,
              failureStreak: 0,
              order: 0,
              archived: false,
              createdAt: now,
              updatedAt: now,
            }),
          ),
        updateCard: () => Effect.sync(() => void (updates += 1)),
      } as unknown as BoardRepositoryShape;
      const harness = makeHarness(undefined, board);
      const created = yield* harness.service.architectCreateOrGet(scopeFor(coordinatorId), {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-board-target-deny",
      });
      const error = yield* Effect.flip(
        harness.service.boardUpdateCard(scopeFor(coordinatorId), {
          cardId,
          executorThreadId: created.architectThreadId,
        }),
      );
      assert.instanceOf(error, OrchestratorMcpFailure);
      assert.strictEqual(error.code, "architect_denied");
      assert.strictEqual(updates, 0);
    }),
  );

  it.effect("denies forged role claims and stale pre-revoke credentials", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const forged = scopeFor(ThreadId.make("ghost-thread"), "architect");
      assert.strictEqual(
        yield* runFailure(
          harness.service.getCoordinatorBinding(forged, { coordinatorThreadId: coordinatorId }),
        ),
        "capability_denied",
      );

      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Is the retry safe?",
        executionPosture: "pause-branch",
        refs: {
          messageIds: [MessageId.make("review-request-message")],
          oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174010"],
        },
        idempotencyKey: "request-1",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");
      const answered = yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: requested.reviewId,
        disposition: "recommendation",
        summary: "Ship it.",
        idempotencyKey: "answer-1",
      });
      assert.strictEqual(answered.status, "answered");

      // Detach revokes the credential; the stale architect scope now fails
      // the durable binding check even though the role claim is unchanged.
      yield* harness.service.architectDetach(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "stale check",
        idempotencyKey: "detach-1",
      });
      assert.isTrue(harness.revoked.includes(created.architectThreadId));
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectureReviewAnswer(archScope, {
            reviewId: requested.reviewId,
            disposition: "recommendation",
            summary: "Ship it again.",
            idempotencyKey: "answer-2",
          }),
        ),
        "architect_denied",
      );
    }),
  );

  it.effect(
    "denies stale credentials across a close-to-revoke crash and recovers audit/delete",
    () =>
      Effect.gen(function* () {
        const backing = makeMemoryStore();
        let injectCrash = true;
        const store: CoordinatorArchitectRepositoryShape = {
          ...backing,
          closeBinding: (input) =>
            Effect.flatMap(backing.closeBinding(input), (closed) => {
              if (input.status === "detached" && injectCrash) {
                injectCrash = false;
                return Effect.fail(new Error("injected crash after durable close") as never);
              }
              return Effect.succeed(closed);
            }),
        };
        const harness = makeHarness(store);
        const scope = scopeFor(coordinatorId);
        const created = yield* harness.service.architectCreateOrGet(scope, {
          coordinatorThreadId: coordinatorId,
          taskEffort: "medium",
          idempotencyKey: "create-close-revoke-crash",
        });
        const requested = yield* harness.service.architectureReviewRequest(scope, {
          coordinatorThreadId: coordinatorId,
          reason: "hard-bug",
          question: "Does the durable close deny a stale credential?",
          executionPosture: "continue",
          idempotencyKey: "request-close-revoke-crash",
        });
        const architectScope = scopeFor(created.architectThreadId, "architect");
        assert.strictEqual(
          yield* runFailure(
            harness.service.architectDetach(scope, {
              coordinatorThreadId: coordinatorId,
              reason: "rollback",
              idempotencyKey: "detach-close-revoke-crash",
            }),
          ),
          "orchestration_error",
        );
        assert.strictEqual(
          (yield* backing.getAnyBindingByArchitect(created.architectThreadId))?.status,
          "detached",
        );
        assert.isFalse(harness.revoked.includes(created.architectThreadId));

        const staleDenial = yield* Effect.flip(
          harness.service.architectureReviewAnswer(architectScope, {
            reviewId: requested.reviewId,
            disposition: "recommendation",
            summary: "This should not be accepted.",
            idempotencyKey: "stale-answer-after-close",
          }),
        );
        assert.instanceOf(staleDenial, OrchestratorMcpFailure);
        assert.strictEqual(staleDenial.code, "architect_denied");

        const outcomes = yield* harness.service.reconcileAfterRestart();
        assert.isTrue(
          outcomes.some((outcome) => outcome.outcome === "terminal-thread-soft-deleted"),
        );
        assert.isTrue(harness.revoked.includes(created.architectThreadId));
        assert.isNull(
          (yield* harness.service.getCoordinatorBinding(scope, {
            coordinatorThreadId: coordinatorId,
          })).binding,
        );
        assert.isTrue(
          harness.threads
            .get(coordinatorId)
            ?.activities.some(
              (activity) =>
                activity.kind === "architect.unbound" &&
                (activity.payload as { readonly bindingId?: unknown }).bindingId ===
                  created.binding.bindingId,
            ),
        );
        assert.strictEqual(
          (yield* backing.getBindingById(created.binding.bindingId))?.status,
          "detached",
        );
        assert.isNull(yield* backing.getActiveBindingByArchitect(created.architectThreadId));
        assert.strictEqual(harness.threads.get(created.architectThreadId)?.deletedAt, now);
        const retainedReviews = yield* harness.service.listArchitectureReviews(scope, {
          coordinatorThreadId: coordinatorId,
        });
        assert.strictEqual(retainedReviews.reviews.length, 1);
        assert.strictEqual(retainedReviews.reviews[0]?.reviewId, requested.reviewId);
      }),
  );

  it.effect("denies executors on every architect and review API", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const executorId = ThreadId.make("executor-1");
      harness.threads.set(
        executorId,
        threadDetail(executorId, {
          delegationParent: { taskId: coordinatorId } as never,
        }),
      );
      const executorScope = scopeFor(executorId);
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectCreateOrGet(executorScope, {
            coordinatorThreadId: executorId,
            taskEffort: "low",
            idempotencyKey: "e-1",
          }),
        ),
        "delegated_executor_denied",
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.listArchitectureReviews(executorScope, {
            coordinatorThreadId: executorId,
          }),
        ),
        "delegated_executor_denied",
      );
      const typedDenial = yield* Effect.flip(
        harness.service.getCoordinatorBinding(executorScope, {
          coordinatorThreadId: executorId,
        }),
      );
      assert.instanceOf(typedDenial, OrchestratorMcpFailure);
      assert.strictEqual(typedDenial.code, "delegated_executor_denied");
    }),
  );

  it.effect("rejects missing posture and disposition with no record created", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectureReviewRequest(scope, {
            coordinatorThreadId: coordinatorId,
            reason: "hard-bug",
            question: "q",
            executionPosture: undefined as never,
            idempotencyKey: "request-1",
          }),
        ),
        "orchestration_error",
      );
      const listed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      assert.deepStrictEqual(listed.reviews, []);

      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "q",
        executionPosture: "continue",
        idempotencyKey: "request-2",
      });
      const created = yield* harness.service.getCoordinatorBinding(scope, {
        coordinatorThreadId: coordinatorId,
      });
      assert.isNotNull(created.binding);
      const archScope = scopeFor(created.binding!.architectThreadId, "architect");
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectureReviewAnswer(archScope, {
            reviewId: requested.reviewId,
            disposition: undefined as never,
            summary: "s",
            idempotencyKey: "answer-1",
          }),
        ),
        "orchestration_error",
      );
      const stored = yield* harness.store.getReviewById(requested.reviewId);
      assert.strictEqual(stored?.status, "open");
    }),
  );

  it.effect("records all three postures as advisory without locking the coordinator", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-advisory-posture",
      });
      const postures = ["continue", "pause-branch", "pause-all"] as const;
      for (const [index, executionPosture] of postures.entries()) {
        const requested = yield* harness.service.architectureReviewRequest(scope, {
          coordinatorThreadId: coordinatorId,
          reason: "milestone-review",
          question: `Posture ${executionPosture} remains advisory?`,
          executionPosture,
          idempotencyKey: `request-advisory-${index}`,
        });
        const stored = yield* harness.store.getReviewById(requested.reviewId);
        assert.strictEqual(stored?.executionPosture, executionPosture);
        assert.strictEqual(stored?.status, "open");
        const architectWake = harness.dispatched.find(
          (command) =>
            command["type"] === "thread.turn.start" &&
            command["threadId"] === created.architectThreadId &&
            command["commandId"] === `arch:review-wake-turn:${requested.reviewId}`,
        );
        assert.isDefined(architectWake);
        assert.include(
          String((architectWake?.["message"] as { readonly text?: unknown } | undefined)?.text),
          `execution posture: ${executionPosture}`,
        );
        assert.strictEqual(
          harness.dispatched.filter(
            (command) =>
              command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
          ).length,
          0,
        );
        const delegated = yield* harness.service.delegateTask(scope, {
          idempotencyKey: `posture-continue-${index}`,
          title: "Continue while review is open",
          prompt: "The review posture is advisory; continue normal coordinator work.",
          role: "implementation",
          target: {
            providerInstanceId,
            driverKind,
            model: "gpt-6-luna",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        assert.strictEqual(delegated.status, "queued");
        assert.isFalse(
          harness.dispatched.some((command) =>
            ["thread.settle", "thread.snooze", "thread.delete"].includes(String(command["type"])),
          ),
        );
      }
    }),
  );

  it.effect("wakes the architect once per request and never the coordinator on answers", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Is the retry safe?",
        executionPosture: "pause-branch",
        idempotencyKey: "request-1",
      });
      const archTurns = harness.dispatched.filter(
        (command) =>
          command["type"] === "thread.turn.start" &&
          command["threadId"] === created.architectThreadId,
      );
      assert.strictEqual(archTurns.length, 1);
      assert.strictEqual(
        archTurns[0]?.["commandId"],
        `arch:review-wake-turn:${requested.reviewId}`,
      );
      const architectWakeText = String(
        (archTurns[0]?.["message"] as { readonly text?: unknown } | undefined)?.text,
      );
      assert.include(
        architectWakeText,
        `Answer this review by calling architecture_review_answer with reviewId ${requested.reviewId}.`,
      );
      assert.include(architectWakeText, "An ordinary answer never wakes the Coordinator.");
      assert.include(
        architectWakeText,
        "Call publish_to_coordinator only if this answer should wake the Coordinator.",
      );
      // The coordinator aggregate carries the typed no-wake reference only:
      // no coordinator turn starts on request.
      assert.deepStrictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ),
        [],
      );
      const archActivities = harness.threads.get(created.architectThreadId)?.activities ?? [];
      assert.isTrue(
        archActivities.some((activity) => activity.kind === "architecture.review-requested"),
      );
      assert.isTrue(
        archActivities.some(
          (activity) =>
            activity.kind === "architecture.review-wake-delivered" &&
            activity.id ===
              `arch:review-wake-delivered:${created.architectThreadId}:${requested.reviewId}`,
        ),
      );
      const coordinatorActivities = harness.threads.get(coordinatorId)?.activities ?? [];
      const reference = coordinatorActivities.find(
        (activity) => activity.kind === "architecture.review-requested-ref",
      );
      assert.isDefined(reference);
      assert.strictEqual(reference?.id, `arch:review-ref:${requested.reviewId}`);
      assert.deepEqual(
        harness.dispatched
          .filter((command) => command["type"] === "thread.turn.start")
          .map((command) => command["threadId"]),
        [created.architectThreadId],
      );
      assert.isFalse(
        harness.dispatched.some((command) => {
          const commandId = String(command["commandId"] ?? "");
          return (
            command["threadId"] === coordinatorId &&
            (commandId.startsWith("delegation-wake:") ||
              commandId.startsWith("delegation-wake-turn:") ||
              commandId.startsWith("delegation-wake-drain:"))
          );
        }),
      );

      const archScope = scopeFor(created.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: requested.reviewId,
        disposition: "needs-human-decision",
        summary: "Needs a human call.",
        idempotencyKey: "answer-1",
      });
      // An answer — regardless of disposition — never wakes the coordinator.
      assert.deepStrictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ),
        [],
      );

      // Exact replay of the request reuses the deterministic wake ids and
      // still yields exactly one architect turn.
      yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Is the retry safe?",
        executionPosture: "pause-branch",
        idempotencyKey: "request-1",
      });
      assert.strictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" &&
            command["threadId"] === created.architectThreadId,
        ).length,
        1,
      );
    }),
  );

  it.effect("publishes once with the stored disposition and replays as a no-op", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "scope-expansion",
        question: "May the branch widen?",
        executionPosture: "continue",
        refs: {
          messageIds: [MessageId.make("published-request-message")],
          oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174011"],
        },
        idempotencyKey: "request-1",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: requested.reviewId,
        disposition: "needs-more-evidence",
        summary: "Show the failing log.",
        oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174012"],
        idempotencyKey: "answer-1",
      });
      const published = yield* harness.service.publishToCoordinator(archScope, {
        reviewId: requested.reviewId,
        idempotencyKey: "publish-1",
      });
      assert.strictEqual(published.status, "published");
      const coordTurns = harness.dispatched.filter(
        (command) =>
          command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
      );
      assert.strictEqual(coordTurns.length, 1);
      assert.strictEqual(
        coordTurns[0]?.["commandId"],
        `arch:publish-wake-turn:${requested.reviewId}`,
      );
      const coordActivities = harness.threads.get(coordinatorId)?.activities ?? [];
      const publishedActivity = coordActivities.find(
        (activity) => activity.kind === "architecture.review-published",
      );
      assert.isDefined(publishedActivity);
      assert.strictEqual(
        (publishedActivity?.payload as { readonly disposition?: unknown }).disposition,
        "needs-more-evidence",
      );
      assert.deepEqual((publishedActivity?.payload as { readonly refs?: unknown }).refs, {
        messageIds: [MessageId.make("published-request-message")],
        oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174011"],
        architectOclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174012"],
      });
      // The delivery marker is written by the provider reactor only after a
      // confirmed send, never by the service at dispatch time.
      assert.isFalse(
        coordActivities.some((activity) => activity.kind === "architecture.publish-wake-delivered"),
      );

      const replay = yield* harness.service.publishToCoordinator(archScope, {
        reviewId: requested.reviewId,
        idempotencyKey: "publish-1",
      });
      assert.strictEqual(replay.status, "published");
      assert.strictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ).length,
        1,
      );
      // Delivery is proven durably once the (simulated) reactor confirms the
      // send; the coordinator sees it in the list.
      const listed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const stored = listed.reviews.find((row) => row.reviewId === requested.reviewId);
      assert.isNotNull(stored?.answeredAt);
      assert.isNotNull(stored?.publishedAt);
      assert.isNotNull(stored?.publishDeliveredAt);
      assert.isNull(stored?.lastPublishFailure);
    }),
  );

  it.effect("creates the architect thread in default interaction mode, never plan", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-default-mode",
      });
      const creates = harness.dispatched.filter(
        (command) =>
          command["type"] === "thread.create" && command["threadId"] === created.architectThreadId,
      );
      assert.strictEqual(creates.length, 1);
      assert.strictEqual(creates[0]?.["interactionMode"], "default");
      // The read-only eligibility check still evaluates the plan envelope.
      assert.strictEqual(creates[0]?.["runtimeMode"], "full-access");
    }),
  );

  it.effect("distinguishes answered-without-delivery from no answer in list", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-delivery-shape",
      });
      const unanswered = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Never answered?",
        executionPosture: "continue",
        idempotencyKey: "request-unanswered",
      });
      const toAnswer = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Answered but never published?",
        executionPosture: "continue",
        idempotencyKey: "request-answered-only",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: toAnswer.reviewId,
        disposition: "recommendation",
        summary: "Ship it.",
        idempotencyKey: "answer-only",
      });
      const listed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const openRow = listed.reviews.find((row) => row.reviewId === unanswered.reviewId);
      assert.strictEqual(openRow?.status, "open");
      assert.isNull(openRow?.answeredAt);
      assert.isNull(openRow?.publishDeliveredAt);
      assert.isNull(openRow?.lastPublishFailure);
      const answeredRow = listed.reviews.find((row) => row.reviewId === toAnswer.reviewId);
      assert.strictEqual(answeredRow?.status, "answered");
      assert.isNotNull(answeredRow?.answeredAt);
      assert.strictEqual(answeredRow?.answerDisposition, "recommendation");
      // Recorded but never delivered: no delivery timestamp, no failure yet.
      assert.isNull(answeredRow?.publishDeliveredAt);
      assert.isNull(answeredRow?.lastPublishFailure);
    }),
  );

  it.effect("leaves a refused publish on the review with its stable reason", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-refused-publish",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Publish before answer?",
        executionPosture: "continue",
        idempotencyKey: "request-refused-publish",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");
      const code = yield* runFailure(
        harness.service.publishToCoordinator(archScope, {
          reviewId: requested.reviewId,
          idempotencyKey: "publish-refused",
        }),
      );
      assert.strictEqual(code, "review_state_conflict");
      // The refusal is durable on the review: still open, never answered,
      // but the reason is visible to the coordinator without reading logs.
      const listed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const stored = listed.reviews.find((row) => row.reviewId === requested.reviewId);
      assert.strictEqual(stored?.status, "open");
      assert.isNull(stored?.answeredAt);
      assert.isNull(stored?.publishDeliveredAt);
      assert.strictEqual(stored?.lastPublishFailure?.reason, "review_state_conflict");
      assert.isNotNull(stored?.lastPublishFailure?.attemptedAt);
    }),
  );

  it.effect("records frozen-scope drift when an answered review cannot be published", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-drifted-publish",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Publish after scope drift?",
        executionPosture: "continue",
        idempotencyKey: "request-drifted-publish",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: requested.reviewId,
        disposition: "recommendation",
        summary: "Ship it.",
        idempotencyKey: "answer-drifted-publish",
      });
      const architect = harness.threads.get(created.architectThreadId);
      assert.isDefined(architect);
      harness.threads.set(created.architectThreadId, {
        ...architect!,
        interactionMode: "plan",
      });

      const code = yield* runFailure(
        harness.service.publishToCoordinator(archScope, {
          reviewId: requested.reviewId,
          idempotencyKey: "publish-drifted",
        }),
      );
      assert.strictEqual(code, "parent_not_active");
      const listed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const stored = listed.reviews.find((row) => row.reviewId === requested.reviewId);
      assert.strictEqual(stored?.status, "answered");
      assert.isNotNull(stored?.answeredAt);
      assert.isNull(stored?.publishedAt);
      assert.isNull(stored?.publishDeliveredAt);
      assert.strictEqual(stored?.lastPublishFailure?.reason, "parent_scope_drift");
      assert.include(stored?.lastPublishFailure?.message, "[reason=parent_scope_drift]");
      assert.isNotNull(stored?.lastPublishFailure?.attemptedAt);
    }),
  );

  it.effect("records a failed publish wake without a silent success, then heals on retry", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-failed-wake",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Wake crash?",
        executionPosture: "continue",
        idempotencyKey: "request-failed-wake",
      });
      const archScope = scopeFor(created.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: requested.reviewId,
        disposition: "recommendation",
        summary: "Ship it.",
        idempotencyKey: "answer-failed-wake",
      });
      harness.setDispatchFailure(
        (command) =>
          command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
      );
      const code = yield* runFailure(
        harness.service.publishToCoordinator(archScope, {
          reviewId: requested.reviewId,
          idempotencyKey: "publish-failed-wake",
        }),
      );
      assert.strictEqual(code, "orchestration_error");
      const failed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const failedRow = failed.reviews.find((row) => row.reviewId === requested.reviewId);
      assert.isNotNull(failedRow?.answeredAt);
      assert.isNull(failedRow?.publishDeliveredAt);
      assert.strictEqual(failedRow?.lastPublishFailure?.reason, "orchestration_error");
      // Retry with the same key: the transition replays, the wake fires, and
      // delivery is proven while the earlier refusal is cleared.
      harness.setDispatchFailure(null);
      const retried = yield* harness.service.publishToCoordinator(archScope, {
        reviewId: requested.reviewId,
        idempotencyKey: "publish-failed-wake",
      });
      assert.strictEqual(retried.status, "published");
      const healed = yield* harness.service.listArchitectureReviews(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const healedRow = healed.reviews.find((row) => row.reviewId === requested.reviewId);
      assert.isNotNull(healedRow?.publishDeliveredAt);
      assert.isNull(healedRow?.lastPublishFailure);
    }),
  );

  it.effect("extracts the stable parent_not_active reason token for the failure record", () =>
    Effect.gen(function* () {
      const drift = new OrchestratorMcpFailure({
        code: "parent_not_active",
        message:
          "The active parent no longer matches the permission scope frozen for this MCP session. [reason=parent_scope_drift] Do not retry in a loop; report reason parent_scope_drift.",
      });
      assert.strictEqual(__testing.publishFailureReasonToken(drift), "parent_scope_drift");
      const plain = new OrchestratorMcpFailure({
        code: "review_state_conflict",
        message: "Only answered reviews can be published.",
      });
      assert.strictEqual(__testing.publishFailureReasonToken(plain), "review_state_conflict");
    }),
  );

  it.effect("keeps all answer dispositions no-wake until one publish wake each", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const coordinatorScope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(coordinatorScope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-disposition-matrix",
      });
      const architectScope = scopeFor(created.architectThreadId, "architect");
      const cases = ["recommendation", "needs-human-decision", "needs-more-evidence"] as const;

      for (const [index, disposition] of cases.entries()) {
        const requested = yield* harness.service.architectureReviewRequest(coordinatorScope, {
          coordinatorThreadId: coordinatorId,
          reason: "direct-advice",
          question: `Disposition ${disposition}?`,
          executionPosture: "continue",
          refs: {
            oclRefs: [`oc://doc/123e4567-e89b-42d3-a456-4266141740${20 + index}`],
          },
          idempotencyKey: `request-disposition-${index}`,
        });
        const coordinatorTurnCountBeforeAnswer = harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ).length;
        yield* harness.service.architectureReviewAnswer(architectScope, {
          reviewId: requested.reviewId,
          disposition,
          summary: `Summary ${disposition}`,
          oclRefs: [`oc://doc/123e4567-e89b-42d3-a456-4266141740${30 + index}`],
          idempotencyKey: `answer-disposition-${index}`,
        });
        assert.strictEqual(
          harness.dispatched.filter(
            (command) =>
              command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
          ).length,
          coordinatorTurnCountBeforeAnswer,
        );

        const published = yield* harness.service.publishToCoordinator(architectScope, {
          reviewId: requested.reviewId,
          idempotencyKey: `publish-disposition-${index}`,
        });
        assert.strictEqual(published.status, "published");
        const turn = harness.dispatched.find(
          (command) =>
            command["type"] === "thread.turn.start" &&
            command["threadId"] === coordinatorId &&
            command["commandId"] === `arch:publish-wake-turn:${requested.reviewId}`,
        );
        assert.isDefined(turn);
        const wakeText = String(
          (turn?.["message"] as { readonly text?: unknown } | undefined)?.text,
        );
        assert.include(wakeText, `[${disposition}]`);
        assert.include(wakeText, `Summary ${disposition}`);
        // The service does not write the delivery marker; only the provider
        // reactor does, after a confirmed provider send.
        assert.isFalse(
          harness.threads
            .get(coordinatorId)
            ?.activities.some(
              (activity) => activity.kind === "architecture.publish-wake-delivered",
            ) ?? false,
        );
      }

      assert.strictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ).length,
        cases.length,
      );
      for (const [index, review] of [...harness.memoryStore!.reviews.values()].entries()) {
        const replay = yield* harness.service.publishToCoordinator(architectScope, {
          reviewId: review.reviewId,
          idempotencyKey: `publish-disposition-${index}`,
        });
        assert.strictEqual(replay.status, "published");
      }
      assert.strictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ).length,
        cases.length,
      );
    }),
  );

  it.effect("replays a missing publish wake without a second provider turn or a false marker", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const coordinatorScope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(coordinatorScope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-publish-crash",
      });
      const requested = yield* harness.service.architectureReviewRequest(coordinatorScope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Can the publish crash be replayed?",
        executionPosture: "pause-branch",
        refs: { oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174041"] },
        idempotencyKey: "request-publish-crash",
      });
      const architectScope = scopeFor(created.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(architectScope, {
        reviewId: requested.reviewId,
        disposition: "needs-human-decision",
        summary: "Confirm the rollout owner.",
        oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174042"],
        idempotencyKey: "answer-publish-crash",
      });
      const published = yield* harness.service.publishToCoordinator(architectScope, {
        reviewId: requested.reviewId,
        idempotencyKey: "publish-crash",
      });
      assert.strictEqual(published.status, "published");
      const coordinatorTurnCount = () =>
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" && command["threadId"] === coordinatorId,
        ).length;
      assert.strictEqual(coordinatorTurnCount(), 1);
      // The service never marks delivery at dispatch time, so the crash window
      // between an accepted start and the reactor's post-send marker is not a
      // false success.
      assert.isFalse(
        harness.threads
          .get(coordinatorId)
          ?.activities.some(
            (activity) => activity.kind === "architecture.publish-wake-delivered",
          ) ?? false,
      );

      const outcomes = yield* harness.service.reconcileAfterRestart();
      assert.isTrue(
        outcomes.some(
          (outcome) => outcome.outcome === `publish-wake-replayed:${requested.reviewId}`,
        ),
      );
      // Replay reuses the deterministic turn command id (receipt dedup), so
      // there is still exactly one coordinator turn and still no marker.
      assert.strictEqual(coordinatorTurnCount(), 1);
      assert.isFalse(
        harness.threads
          .get(coordinatorId)
          ?.activities.some(
            (activity) => activity.kind === "architecture.publish-wake-delivered",
          ) ?? false,
      );
    }),
  );

  it.effect("rejects cancel-then-publish and publish-then-cancel as terminal conflicts", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const first = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "direct-advice",
        question: "First?",
        executionPosture: "continue",
        idempotencyKey: "request-1",
      });
      yield* harness.service.architectureReviewCancel(scope, {
        reviewId: first.reviewId,
        reason: "no longer needed",
        idempotencyKey: "cancel-1",
      });
      assert.strictEqual(
        yield* runFailure(
          harness.service.publishToCoordinator(scope, {
            reviewId: first.reviewId,
            idempotencyKey: "publish-1",
          }),
        ),
        "review_state_conflict",
      );

      const second = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "direct-advice",
        question: "Second?",
        executionPosture: "continue",
        idempotencyKey: "request-2",
      });
      const created = yield* harness.service.getCoordinatorBinding(scope, {
        coordinatorThreadId: coordinatorId,
      });
      const archScope = scopeFor(created.binding!.architectThreadId, "architect");
      yield* harness.service.architectureReviewAnswer(archScope, {
        reviewId: second.reviewId,
        disposition: "recommendation",
        summary: "Go.",
        idempotencyKey: "answer-2",
      });
      yield* harness.service.publishToCoordinator(archScope, {
        reviewId: second.reviewId,
        idempotencyKey: "publish-2",
      });
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectureReviewCancel(scope, {
            reviewId: second.reviewId,
            reason: "too late",
            idempotencyKey: "cancel-2",
          }),
        ),
        "review_state_conflict",
      );
      // Architect cancel is denied even for its own reviews.
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectureReviewCancel(archScope, {
            reviewId: second.reviewId,
            reason: "architect attempt",
            idempotencyKey: "cancel-3",
          }),
        ),
        "architect_denied",
      );
    }),
  );

  it.effect("scopes queries to the caller and denies out-of-lineage access", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const otherScope = scopeFor(otherCoordinatorId);
      yield* harness.service.architectCreateOrGet(otherScope, {
        coordinatorThreadId: otherCoordinatorId,
        taskEffort: "low",
        idempotencyKey: "create-1",
      });
      const own = yield* harness.service.getCoordinatorBinding(scope, {
        coordinatorThreadId: coordinatorId,
      });
      assert.isNotNull(own.binding);
      const archScope = scopeFor(own.binding!.architectThreadId, "architect");
      const ownReviews = yield* harness.service.listArchitectureReviews(archScope, {
        coordinatorThreadId: coordinatorId,
      });
      assert.deepStrictEqual(ownReviews.reviews, []);
      assert.strictEqual(
        yield* runFailure(
          harness.service.getCoordinatorBinding(archScope, {
            coordinatorThreadId: otherCoordinatorId,
          }),
        ),
        "architect_denied",
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.listArchitectureReviews(otherScope, {
            coordinatorThreadId: coordinatorId,
          }),
        ),
        "capability_denied",
      );
    }),
  );

  it.effect("resolves architect task reads against the linked coordinator lineage", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const childId = ThreadId.make("executor-1");
      harness.threads.set(
        childId,
        threadDetail(childId, { activities: [lineageActivity(childId, coordinatorId)] }),
      );
      harness.memoryRows.push({
        parentThreadId: coordinatorId,
        taskId: childId,
        projectId,
        role: "implementation",
        title: "Executor",
        updatedAt: now,
        worktreePath: null,
        latestTurnId: null,
        latestTurnState: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasPendingFollowUp: false,
        threadWatermark: 1,
        summary: null,
      });
      const strangerId = ThreadId.make("executor-2");
      harness.threads.set(
        strangerId,
        threadDetail(strangerId, { activities: [lineageActivity(strangerId, otherCoordinatorId)] }),
      );
      harness.memoryRows.push({
        parentThreadId: otherCoordinatorId,
        taskId: strangerId,
        projectId,
        role: "implementation",
        title: "Stranger",
        updatedAt: now,
        worktreePath: null,
        latestTurnId: null,
        latestTurnState: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasPendingFollowUp: false,
        threadWatermark: 1,
        summary: null,
      });

      const archScope = scopeFor(created.architectThreadId, "architect");
      const listed = yield* harness.service.taskList(archScope, {});
      assert.deepStrictEqual(
        listed.tasks.map((task) => task.taskId),
        [childId],
      );
      const read = yield* harness.service.taskStatus(archScope, childId);
      assert.strictEqual(read.taskId, childId);
      assert.strictEqual(
        yield* runFailure(harness.service.taskStatus(archScope, strangerId)),
        "task_not_found",
      );
    }),
  );

  it.effect("denies every command while the flag is off and leaves other flows alone", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const bound = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      harness.setFlag(false);
      assert.strictEqual(
        yield* runFailure(
          harness.service.architectCreateOrGet(scope, {
            coordinatorThreadId: coordinatorId,
            taskEffort: "medium",
            idempotencyKey: "create-2",
          }),
        ),
        "feature_disabled",
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.getCoordinatorBinding(scope, { coordinatorThreadId: coordinatorId }),
        ),
        "feature_disabled",
      );
      assert.strictEqual(
        yield* runFailure(
          harness.service.listArchitectureReviews(scope, { coordinatorThreadId: coordinatorId }),
        ),
        "feature_disabled",
      );
      // Bindings and reviews persist while disabled; coordinator/executor
      // flows never consult the flag.
      assert.isNotNull(harness.memoryStore!.bindings.get(bound.binding.bindingId) ?? null);
      // Park the coordinator turn so delegate_task fails at the active-turn
      // gate (parent_not_active), proving the flag gate never touches it.
      harness.threads.set(coordinatorId, threadDetail(coordinatorId, { idle: true }));
      assert.strictEqual(
        yield* runFailure(
          harness.service.delegateTask(scope, {
            idempotencyKey: "x",
            title: "x",
            prompt: "x",
            role: "implementation",
            target: {
              providerInstanceId,
              driverKind,
              model: "m",
              options: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ),
        "parent_not_active",
      );
      harness.setFlag(true);
      const rebound = yield* harness.service.getCoordinatorBinding(scope, {
        coordinatorThreadId: coordinatorId,
      });
      assert.isNotNull(rebound.binding);
    }),
  );

  it.effect(
    "permanent rollback detaches before disabling and never restores a terminal binding",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const scope = scopeFor(coordinatorId);
        const created = yield* harness.service.architectCreateOrGet(scope, {
          coordinatorThreadId: coordinatorId,
          taskEffort: "medium",
          idempotencyKey: "rollback-create",
        });
        const detached = yield* harness.service.architectDetach(scope, {
          coordinatorThreadId: coordinatorId,
          reason: "Permanent Phase 1 rollback.",
          idempotencyKey: "rollback-detach",
        });
        assert.strictEqual(detached.binding.status, "detached");
        assert.isTrue(harness.revoked.includes(created.architectThreadId));
        assert.strictEqual(harness.threads.get(created.architectThreadId)?.deletedAt, now);

        harness.setFlag(false);
        assert.strictEqual(
          yield* runFailure(
            harness.service.architectCreateOrGet(scope, {
              coordinatorThreadId: coordinatorId,
              taskEffort: "medium",
              idempotencyKey: "rollback-replay-create",
            }),
          ),
          "feature_disabled",
        );
        harness.setFlag(true);

        // An exact replay of the terminal create key cannot reopen credentials
        // or surface the old Architect in the ordinary active-binding query.
        assert.strictEqual(
          yield* runFailure(
            harness.service.architectCreateOrGet(scope, {
              coordinatorThreadId: coordinatorId,
              taskEffort: "medium",
              idempotencyKey: "rollback-create",
            }),
          ),
          "binding_not_found",
        );
        const sidebar = yield* harness.service.getCoordinatorBinding(scope, {
          coordinatorThreadId: coordinatorId,
        });
        assert.isNull(sidebar.binding);
        assert.strictEqual(
          (yield* harness.store.getBindingById(created.binding.bindingId))?.status,
          "detached",
        );
      }),
  );

  it.effect("replays an open review to a replacement architect with a thread-scoped command", () =>
    Effect.gen(function* () {
      const harness = makeHarness(undefined, undefined, true);
      const scope = scopeFor(coordinatorId);
      const original = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-before-review-replacement",
      });
      const review = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Can the replacement architect review this?",
        executionPosture: "continue",
        idempotencyKey: "review-before-replacement",
      });
      const replacement = yield* harness.service.architectReplace(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        modelSelection: architectModelSelection,
        routingEvidence: architectRoutingEvidence("medium"),
        reason: "The original architect is unavailable.",
        idempotencyKey: "replace-for-review",
      });
      assert.notStrictEqual(replacement.binding.architectThreadId, original.architectThreadId);

      const outcomes = yield* harness.service.reconcileAfterRestart();
      assert.isTrue(
        outcomes.some((outcome) => outcome.outcome === `review-wake-replayed:${review.reviewId}`),
      );
      const replacementTurns = harness.dispatched.filter(
        (command) =>
          command["type"] === "thread.turn.start" &&
          command["threadId"] === replacement.binding.architectThreadId,
      );
      assert.strictEqual(replacementTurns.length, 1);
      assert.strictEqual(
        replacementTurns[0]?.["commandId"],
        `arch:review-wake-turn:${replacement.binding.architectThreadId}:${review.reviewId}`,
      );
      assert.isTrue(
        harness.threads
          .get(replacement.binding.architectThreadId)
          ?.activities.some(
            (activity) =>
              activity.id ===
              `arch:review-wake-delivered:${replacement.binding.architectThreadId}:${review.reviewId}`,
          ),
      );
      yield* harness.service.reconcileAfterRestart();
      assert.strictEqual(
        harness.dispatched.filter(
          (command) =>
            command["type"] === "thread.turn.start" &&
            command["threadId"] === replacement.binding.architectThreadId,
        ).length,
        1,
      );
    }),
  );

  it.effect("reconciles missing threads, marker gaps, and binding-less orphans", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = scopeFor(coordinatorId);
      const created = yield* harness.service.architectCreateOrGet(scope, {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-1",
      });
      const requested = yield* harness.service.architectureReviewRequest(scope, {
        coordinatorThreadId: coordinatorId,
        reason: "hard-bug",
        question: "Replay me?",
        executionPosture: "continue",
        idempotencyKey: "request-1",
      });
      // Simulate a crash between wake dispatch and marker: drop the marker.
      const archThread = harness.threads.get(created.architectThreadId)!;
      harness.threads.set(created.architectThreadId, {
        ...archThread,
        activities: archThread.activities.filter(
          (activity) => activity.kind !== "architecture.review-wake-delivered",
        ),
      });
      const archTurnsBefore = harness.dispatched.filter(
        (command) => command["type"] === "thread.turn.start",
      ).length;

      // A binding-less architect thread from a lost replace race.
      const orphanId = ThreadId.make("arch:orphan-1");
      harness.threads.set(orphanId, threadDetail(orphanId));

      const outcomes = yield* harness.service.reconcileAfterRestart();
      assert.isTrue(
        outcomes.some(
          (outcome) => outcome.outcome === `review-wake-replayed:${requested.reviewId}`,
        ),
      );
      assert.isTrue(outcomes.some((outcome) => outcome.outcome === "orphan-soft-deleted"));
      assert.isTrue(harness.revoked.includes(orphanId));
      assert.strictEqual(harness.threads.get(orphanId)?.deletedAt, now);
      assert.isTrue(
        harness.threads
          .get(orphanId)
          ?.activities.some(
            (activity) =>
              activity.kind === "architect.unbound" &&
              (activity.payload as { readonly architectThreadId?: unknown }).architectThreadId ===
                orphanId &&
              (activity.payload as { readonly reason?: unknown }).reason === "binding-race-lost",
          ),
      );
      // The receipt for the already accepted wake suppresses a second turn.
      assert.strictEqual(
        harness.dispatched.filter((command) => command["type"] === "thread.turn.start").length,
        archTurnsBefore,
      );

      // A successful create receipt followed by a missing thread is a
      // down-time loss, so reconciliation detaches and audits it once.
      harness.threads.delete(created.architectThreadId);
      const second = yield* harness.service.reconcileAfterRestart();
      assert.isTrue(second.some((outcome) => outcome.outcome === "thread-missing-after-restart"));
      const binding = yield* harness.store.getBindingById(created.binding.bindingId);
      assert.strictEqual(binding?.status, "detached");
      assert.strictEqual(binding?.detachReason, "thread-missing-after-restart");
      assert.isTrue(harness.revoked.includes(created.architectThreadId));
      assert.isTrue(
        harness.threads
          .get(coordinatorId)
          ?.activities.some(
            (activity) =>
              activity.id === `architect-unbound:${created.binding.bindingId}` &&
              activity.kind === "architect.unbound" &&
              (activity.payload as { readonly reason?: unknown }).reason ===
                "thread-missing-after-restart",
          ),
      );
      assert.deepStrictEqual(yield* harness.service.reconcileAfterRestart(), []);
      assert.strictEqual(
        harness.threads
          .get(coordinatorId)
          ?.activities.filter(
            (activity) => activity.id === `architect-unbound:${created.binding.bindingId}`,
          ).length,
        1,
      );
    }),
  );

  it.effect("self-heals a binding-first create crash across restart exactly once", () =>
    Effect.gen(function* () {
      const store = makeMemoryStore();
      const firstProcess = makeHarness(store);
      const scope = scopeFor(coordinatorId);
      const input = {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium" as const,
        idempotencyKey: "create-crash-window",
      };
      firstProcess.setDispatchFailure((command) => command["type"] === "thread.create");
      const failedCreate = yield* runFailure(
        firstProcess.service.architectCreateOrGet(scope, input),
      );
      assert.strictEqual(failedCreate, "orchestration_error");
      assert.strictEqual(
        (yield* store.getActiveBindingByCoordinator(coordinatorId))?.status,
        "active",
      );
      assert.strictEqual(firstProcess.threads.size, 2);

      const restartedProcess = makeHarness(store);
      const outcomes = yield* restartedProcess.service.reconcileAfterRestart();
      assert.isTrue(outcomes.some((outcome) => outcome.outcome === "architect-thread-recovered"));
      const active = yield* store.getActiveBindingByCoordinator(coordinatorId);
      assert.isNotNull(active);
      if (active === null) return;
      assert.isNotNull(restartedProcess.threads.get(active.architectThreadId));
      assert.strictEqual(
        restartedProcess.dispatched.filter((command) => command["type"] === "thread.create").length,
        1,
      );

      yield* restartedProcess.service.architectCreateOrGet(scope, input);
      const replay = yield* restartedProcess.service.reconcileAfterRestart();
      assert.deepStrictEqual(replay, []);
      assert.strictEqual(
        restartedProcess.dispatched.filter((command) => command["type"] === "thread.create").length,
        1,
      );
      assert.strictEqual(
        restartedProcess.threads
          .get(coordinatorId)
          ?.activities.filter((activity) => activity.kind === "architect.bound").length,
        1,
      );
    }),
  );

  it.effect("replays the missing-thread Coordinator notice after a close-to-audit crash", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const created = yield* harness.service.architectCreateOrGet(scopeFor(coordinatorId), {
        coordinatorThreadId: coordinatorId,
        taskEffort: "medium",
        idempotencyKey: "create-missing-audit-crash",
      });
      harness.threads.delete(created.architectThreadId);
      harness.setDispatchFailure(
        (command) => command["commandId"] === `architect-unbound:${created.binding.bindingId}`,
      );
      assert.strictEqual(
        yield* runFailure(harness.service.reconcileAfterRestart()),
        "orchestration_error",
      );
      assert.strictEqual(
        (yield* harness.store.getBindingById(created.binding.bindingId))?.detachReason,
        "thread-missing-after-restart",
      );

      const restarted = makeHarness(harness.store);
      const outcomes = yield* restarted.service.reconcileAfterRestart();
      assert.isTrue(
        outcomes.some((outcome) => outcome.outcome === "missing-architect-close-audit-replayed"),
      );
      const notices = restarted.threads
        .get(coordinatorId)
        ?.activities.filter(
          (activity) => activity.id === `architect-unbound:${created.binding.bindingId}`,
        );
      assert.strictEqual(notices?.length, 1);
      assert.strictEqual(
        (notices?.[0]?.payload as { readonly reason?: unknown } | undefined)?.reason,
        "thread-missing-after-restart",
      );
    }),
  );

  it.effect("reconciles a live binding through the real SQLite review query without a status", () =>
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* CoordinatorArchitectRepository;
        const harness = makeHarness(store);
        const created = yield* harness.service.architectCreateOrGet(scopeFor(coordinatorId), {
          coordinatorThreadId: coordinatorId,
          taskEffort: "medium",
          idempotencyKey: "sqlite-reconcile-create",
        });

        assert.deepStrictEqual(yield* harness.service.reconcileAfterRestart(), []);
        const stillActive = yield* store.getActiveBindingByCoordinator(coordinatorId);
        assert.strictEqual(stillActive?.bindingId, created.binding.bindingId);
      }),
      CoordinatorArchitectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
  );
});
