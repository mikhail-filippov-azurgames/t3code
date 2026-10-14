import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestratorMcpFailure,
  type OrchestratorMcpFailureCode,
  type OrchestratorMcpTaskMemoryEntry,
  type OrchestratorMcpTaskReadInput,
  type OrchestratorMcpTaskSearchInput,
  type OrchestratorMcpTaskSummaryHistoryInput,
  type OrchestratorMcpTaskSummaryHistoryResult,
  type OrchestratorMcpTaskResult,
  type OrchestratorMcpTaskStatus,
  type OrchestratorMcpTaskWaitResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { scrubDelegatedTaskText } from "../../../DelegatedTaskMemoryText.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { projectDerivedText } from "../../../security/SecretTextPolicy.ts";
import type { OrchestratorMcpServiceShape } from "./service.ts";

const TASK_SEARCH_MAX_SCAN = 500;

interface TaskCancellationLineage {
  readonly taskId: ThreadId;
  readonly delegatedMessageId: MessageId;
  readonly requestFingerprint: string;
}

interface TaskQueryServiceDependencies<TLineage extends TaskCancellationLineage> {
  readonly dispatch: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
  readonly now: Effect.Effect<string, OrchestratorMcpFailure>;
  readonly listDelegatedTaskMemoryRows?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["listDelegatedTaskMemoryRows"];
  readonly listDelegatedTaskSummaryHistory?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["listDelegatedTaskSummaryHistory"];
  readonly getThreadDetailSnapshotIncludingArchived?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadDetailSnapshotIncludingArchived"];
  readonly taskSearchBatchSize: number;
  readonly cancelRequestedActivity: string;
  readonly cancelledActivity: string;
  readonly failure: (code: OrchestratorMcpFailureCode, message: string) => OrchestratorMcpFailure;
  readonly orchestrationFailure: (operation: string) => (error: unknown) => OrchestratorMcpFailure;
  readonly deterministicId: (prefix: string, ...parts: ReadonlyArray<string>) => string;
  readonly requireCapability: (
    scope: McpInvocationScope,
  ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  readonly resolveReadScope: (
    scope: McpInvocationScope,
  ) => Effect.Effect<McpInvocationScope, OrchestratorMcpFailure>;
  readonly denyArchitectCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly denyArchitectTarget: (
    taskId: ThreadId,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly loadThreadDetail: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, OrchestratorMcpFailure>;
  readonly listTurns: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, OrchestratorMcpFailure>;
  readonly findLineage: (thread: OrchestrationThread) => TLineage | null;
  readonly wasCancelRequested: (thread: OrchestrationThread, lineage: TLineage) => boolean;
  readonly readOwnedTask: (
    scope: McpInvocationScope,
    taskId: ThreadId,
  ) => Effect.Effect<OrchestratorMcpTaskResult, OrchestratorMcpFailure>;
  readonly waitForTask: (
    scope: McpInvocationScope,
    taskId: ThreadId,
    timeoutMs: number,
  ) => Effect.Effect<OrchestratorMcpTaskWaitResult, OrchestratorMcpFailure>;
  readonly isTerminalStatus: (status: OrchestratorMcpTaskResult["status"]) => boolean;
}

export function makeTaskQueryService<TLineage extends TaskCancellationLineage>(
  dependencies: TaskQueryServiceDependencies<TLineage>,
): Pick<
  OrchestratorMcpServiceShape,
  | "taskList"
  | "taskSearch"
  | "taskSummaryHistory"
  | "taskRead"
  | "taskStatus"
  | "taskWait"
  | "taskCancel"
> {
  const loadTaskMemoryRows = (
    scope: McpInvocationScope,
    input: {
      readonly afterTaskId?: ThreadId;
      readonly taskId?: ThreadId;
      readonly limit: number;
    },
  ) =>
    Effect.gen(function* () {
      yield* dependencies.requireCapability(scope);
      if (dependencies.listDelegatedTaskMemoryRows === undefined) {
        return yield* dependencies.failure(
          "orchestration_error",
          "Delegated task memory is unavailable.",
        );
      }
      return yield* dependencies
        .listDelegatedTaskMemoryRows({
          parentEnvironmentId: scope.environmentId,
          parentThreadId: scope.threadId,
          ...input,
        })
        .pipe(Effect.mapError(dependencies.orchestrationFailure("read delegated task memory")));
    });

  const loadTaskSummaryHistoryPage = (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskSummaryHistoryInput,
  ) =>
    Effect.gen(function* () {
      yield* dependencies.requireCapability(scope);
      if (dependencies.listDelegatedTaskSummaryHistory === undefined) {
        return yield* dependencies.failure(
          "orchestration_error",
          "Delegated task summary history is unavailable.",
        );
      }
      return yield* dependencies
        .listDelegatedTaskSummaryHistory({
          parentEnvironmentId: scope.environmentId,
          parentThreadId: scope.threadId,
          ...input,
          limit: input.limit ?? 50,
        })
        .pipe(
          Effect.mapError(dependencies.orchestrationFailure("read delegated task summary history")),
        );
    });

  const recordCancellationCompleted = Effect.fn(
    "OrchestratorMcpService.recordCancellationCompleted",
  )(function* (input: {
    readonly taskId: ThreadId;
    readonly lineage: TLineage;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly reason: "provider-interrupted" | "provider-not-active" | "start-suppressed";
  }) {
    yield* dependencies
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          dependencies.deterministicId(
            "mcp-delegation-cancelled",
            input.taskId,
            input.lineage.requestFingerprint,
          ),
        ),
        threadId: input.taskId,
        activity: {
          id: EventId.make(
            dependencies.deterministicId(
              "mcp-delegation-cancelled",
              input.taskId,
              input.lineage.requestFingerprint,
            ),
          ),
          tone: "info",
          kind: dependencies.cancelledActivity,
          summary: "Delegated task cancelled",
          payload: {
            taskId: input.taskId,
            delegatedMessageId: input.lineage.delegatedMessageId,
            delegatedTurnId: input.turnId,
            reason: input.reason,
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.mapError(dependencies.orchestrationFailure("record delegated-task cancellation")),
      );
  });

  return {
    taskList: (scope, input) =>
      Effect.gen(function* () {
        const readScope = yield* dependencies.resolveReadScope(scope);
        const limit = input.limit ?? 50;
        const page = yield* loadTaskMemoryRows(readScope, {
          limit,
          ...(input.afterTaskId === undefined ? {} : { afterTaskId: input.afterTaskId }),
        });
        const tasks = page.rows.map(toTaskMemoryEntry);
        return {
          tasks,
          nextCursor: page.hasMore ? (tasks.at(-1)?.taskId ?? null) : null,
        };
      }),
    taskSearch: (scope, input: OrchestratorMcpTaskSearchInput) =>
      Effect.gen(function* () {
        const readScope = yield* dependencies.resolveReadScope(scope);
        const limit = input.limit ?? 50;
        const query = scrubDelegatedTaskText(input.query).trim().slice(0, 256);
        const foldedQuery = query.toLocaleLowerCase();
        const matches: Array<OrchestratorMcpTaskMemoryEntry> = [];
        let cursor = input.afterTaskId;
        let scanned = 0;
        let hasMoreCandidates = true;
        while (scanned < TASK_SEARCH_MAX_SCAN && hasMoreCandidates && matches.length <= limit) {
          const batchLimit = Math.min(
            dependencies.taskSearchBatchSize,
            TASK_SEARCH_MAX_SCAN - scanned,
          );
          const page = yield* loadTaskMemoryRows(readScope, {
            limit: batchLimit,
            ...(cursor === undefined ? {} : { afterTaskId: cursor }),
          });
          const tasks = page.rows.map(toTaskMemoryEntry);
          scanned += tasks.length;
          for (const task of tasks) {
            const searchable = [
              task.role,
              task.title,
              task.worktreePath ?? "",
              task.summary?.text ?? "",
            ]
              .join("\n")
              .toLocaleLowerCase();
            const exactIdMatch =
              task.taskId === query ||
              task.childThreadId === query ||
              task.latestTurnId === query ||
              task.summary?.sourceTurnIds.some((turnId) => turnId === query) === true;
            if (
              exactIdMatch ||
              task.worktreePath === query ||
              task.latestStatus === query ||
              searchable.includes(foldedQuery)
            ) {
              matches.push(task);
              if (matches.length > limit) break;
            }
          }
          cursor = tasks.at(-1)?.taskId ?? cursor;
          hasMoreCandidates = page.hasMore;
          if (tasks.length === 0 || matches.length > limit) break;
        }
        const tasks = matches.slice(0, limit);
        const nextCursor =
          matches.length > limit
            ? (tasks.at(-1)?.taskId ?? null)
            : hasMoreCandidates
              ? (cursor ?? null)
              : null;
        return {
          query,
          tasks,
          nextCursor,
        };
      }),
    taskSummaryHistory: (scope, input) =>
      Effect.gen(function* () {
        const readScope = yield* dependencies.resolveReadScope(scope);
        const page = yield* loadTaskSummaryHistoryPage(readScope, input);
        return {
          records: page.records.map(toTaskSummaryHistoryRecord),
          nextCursor: page.nextCursor,
        };
      }),
    taskRead: (scope, input: OrchestratorMcpTaskReadInput) =>
      Effect.gen(function* () {
        const readScope = yield* dependencies.resolveReadScope(scope);
        const ownership = yield* loadTaskMemoryRows(readScope, { taskId: input.taskId, limit: 1 });
        const child = ownership.rows[0];
        if (child === undefined) {
          return yield* dependencies.failure("task_not_found", "The delegated task was not found.");
        }
        if (dependencies.getThreadDetailSnapshotIncludingArchived === undefined) {
          return yield* dependencies.failure(
            "orchestration_error",
            "Delegated task transcript reads are unavailable.",
          );
        }
        const snapshot = yield* dependencies
          .getThreadDetailSnapshotIncludingArchived(input.taskId, {
            turnLimit: input.turnLimit ?? 8,
            ...(input.beforeCursor === undefined ? {} : { beforeCursor: input.beforeCursor }),
          })
          .pipe(
            Effect.mapError(dependencies.orchestrationFailure("read delegated task transcript")),
          );
        if (Option.isNone(snapshot)) {
          return yield* dependencies.failure("task_not_found", "The delegated task was not found.");
        }
        const detail = snapshot.value;
        const page = detail.page;
        if (page === undefined) {
          return yield* dependencies.failure(
            "orchestration_error",
            "Transcript pagination metadata is unavailable.",
          );
        }
        return {
          taskId: child.taskId,
          title: toTaskMemoryEntry(child).title,
          messages: detail.thread.messages.map((message) => ({
            ...message,
            text: projectDerivedText("read", message.text),
          })),
          activities: detail.thread.activities.map((activity) => ({
            ...activity,
            summary: projectDerivedText("read", activity.summary),
            payload: projectReadTextValue(activity.payload),
          })),
          page,
        };
      }),
    taskStatus: (scope, taskId) =>
      Effect.gen(function* () {
        return yield* dependencies.readOwnedTask(
          yield* dependencies.resolveReadScope(scope),
          taskId,
        );
      }),
    taskWait: (scope, taskId, timeoutMs) =>
      Effect.gen(function* () {
        return yield* dependencies.waitForTask(
          yield* dependencies.resolveReadScope(scope),
          taskId,
          timeoutMs,
        );
      }),
    taskCancel: (scope, taskId) =>
      Effect.gen(function* () {
        yield* dependencies.denyArchitectCaller(scope, "cancel delegated tasks");
        yield* dependencies.denyArchitectTarget(taskId, "task_cancel");
        const current = yield* dependencies.readOwnedTask(scope, taskId);
        if (dependencies.isTerminalStatus(current.status)) return current;
        const threadOption = yield* dependencies.loadThreadDetail(taskId);
        if (Option.isNone(threadOption)) {
          return yield* dependencies.failure("task_not_found", "The delegated task was not found.");
        }
        const thread = threadOption.value;
        const lineage = dependencies.findLineage(thread);
        if (lineage === null) {
          return yield* dependencies.failure("task_not_found", "The delegated task was not found.");
        }
        const rows = yield* dependencies.listTurns(taskId);
        const bound = rows.find(
          (row) => row.pendingMessageId === lineage.delegatedMessageId && row.turnId !== null,
        );
        const pending = rows.filter(
          (row) => row.turnId === null && row.pendingMessageId === lineage.delegatedMessageId,
        );
        const activeTurnId = thread.session?.activeTurnId ?? null;
        if (
          dependencies.wasCancelRequested(thread, lineage) &&
          bound?.turnId !== null &&
          bound?.turnId !== undefined &&
          bound.state === "interrupted" &&
          activeTurnId === null
        ) {
          const completedAt = yield* dependencies.now;
          yield* recordCancellationCompleted({
            taskId,
            lineage,
            turnId: bound.turnId,
            createdAt: completedAt,
            reason: "provider-not-active",
          });
          return yield* dependencies.readOwnedTask(scope, taskId);
        }
        const canInterruptBound =
          bound?.turnId !== null && bound?.turnId !== undefined && activeTurnId === bound.turnId;
        const canInterruptPending =
          bound === undefined && pending.length === 1 && activeTurnId === null;
        if (!canInterruptBound && !canInterruptPending) {
          return yield* dependencies.failure(
            "task_not_cancellable",
            "The delegated turn is not the child's active or uniquely pending turn.",
          );
        }
        const now = yield* dependencies.now;
        if (!dependencies.wasCancelRequested(thread, lineage)) {
          yield* dependencies
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(
                dependencies.deterministicId(
                  "mcp-delegation-cancel",
                  taskId,
                  lineage.requestFingerprint,
                ),
              ),
              threadId: taskId,
              activity: {
                id: EventId.make(
                  dependencies.deterministicId(
                    "mcp-delegation-cancel",
                    taskId,
                    lineage.requestFingerprint,
                  ),
                ),
                tone: "info",
                kind: dependencies.cancelRequestedActivity,
                summary: "Delegated task cancellation requested",
                payload: {
                  taskId,
                  delegatedMessageId: lineage.delegatedMessageId,
                  delegatedTurnId: bound?.turnId ?? null,
                },
                turnId: bound?.turnId ?? null,
                createdAt: now,
              },
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                dependencies.orchestrationFailure("record delegated-task cancellation"),
              ),
            );
        }
        const failedRequestIds = failedCancellationRequestIds(thread);
        let attempt = 1;
        let interruptCommandId = CommandId.make(
          dependencies.deterministicId(
            "mcp-delegation-interrupt",
            taskId,
            lineage.requestFingerprint,
            String(attempt),
          ),
        );
        while (failedRequestIds.has(interruptCommandId)) {
          attempt += 1;
          interruptCommandId = CommandId.make(
            dependencies.deterministicId(
              "mcp-delegation-interrupt",
              taskId,
              lineage.requestFingerprint,
              String(attempt),
            ),
          );
        }
        yield* dependencies
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: interruptCommandId,
            threadId: taskId,
            ...(bound?.turnId === null || bound?.turnId === undefined
              ? { pendingMessageId: lineage.delegatedMessageId }
              : { turnId: bound.turnId }),
            createdAt: now,
          })
          .pipe(
            Effect.mapError(dependencies.orchestrationFailure("interrupt delegated provider turn")),
          );
        return yield* dependencies.readOwnedTask(scope, taskId);
      }),
  };
}

function toTaskMemoryEntry(
  row: ProjectionSnapshotQuery.DelegatedTaskMemoryRow,
): OrchestratorMcpTaskMemoryEntry {
  const role = scrubDelegatedTaskText(row.role).slice(0, 100);
  const title = scrubDelegatedTaskText(row.title).slice(0, 500);
  const latestStatus: OrchestratorMcpTaskStatus =
    row.hasPendingApprovals || row.hasPendingUserInput
      ? "waiting"
      : row.hasPendingFollowUp
        ? "queued"
        : row.latestTurnId === null
          ? "queued"
          : row.latestTurnState === "error"
            ? "failed"
            : row.latestTurnState === "pending"
              ? "queued"
              : (row.latestTurnState ?? "queued");
  const summary = row.summary;
  return {
    taskId: row.taskId,
    childThreadId: row.taskId,
    role,
    title,
    latestStatus,
    latestTurnId: row.latestTurnId,
    updatedAt: row.updatedAt,
    worktreePath:
      row.worktreePath === null ? null : scrubDelegatedTaskText(row.worktreePath).slice(0, 1_024),
    summary:
      summary === null
        ? {
            text: projectDerivedText(
              "summary",
              scrubDelegatedTaskText(`${role || "Task"}: ${title}`),
            ).slice(0, 240),
            source: "deterministic",
            sourceTurnIds: row.latestTurnId === null ? [] : [row.latestTurnId],
            watermark: 0,
            stale: true,
            state: "pending",
            error: null,
          }
        : {
            text: projectDerivedText("summary", scrubDelegatedTaskText(summary.text)).slice(0, 600),
            source: summary.source,
            sourceTurnIds: summary.sourceTurnIds.slice(-ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX),
            watermark: summary.watermark,
            stale:
              summary.state !== "ready" ||
              summary.sourceTurnId !== row.latestTurnId ||
              summary.watermark < row.threadWatermark ||
              row.hasPendingFollowUp,
            state: summary.state,
            error:
              summary.error === null
                ? null
                : projectDerivedText("summary", scrubDelegatedTaskText(summary.error)),
          },
  };
}

function toTaskSummaryHistoryRecord(
  row: ProjectionSnapshotQuery.DelegatedTaskSummaryHistoryRecord,
): OrchestratorMcpTaskSummaryHistoryResult["records"][number] {
  return {
    ...row,
    summaryText: projectDerivedText("summary", scrubDelegatedTaskText(row.summaryText)),
    executorRole: scrubDelegatedTaskText(row.executorRole).slice(0, 100),
  };
}

function projectReadTextValue<T>(value: T): T {
  if (typeof value === "string") return projectDerivedText("read", value) as T;
  if (Array.isArray(value)) return value.map(projectReadTextValue) as T;
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, projectReadTextValue(nested)]),
    ) as T;
  }
  return value;
}

function failedCancellationRequestIds(thread: OrchestrationThread): ReadonlySet<string> {
  return new Set(
    thread.activities.flatMap((activity) =>
      activity.kind === "provider.turn.interrupt.failed" &&
      Predicate.isObject(activity.payload) &&
      typeof activity.payload.requestId === "string"
        ? [activity.payload.requestId]
        : [],
    ),
  );
}
