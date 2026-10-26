import {
  EventId,
  OrchestratorMcpFailure,
  OrchestrationV2TurnItemJson,
  type MessageId,
  type NodeId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadHistoryPage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import {
  decodeThreadHistoryCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_PAGE_POLICY,
} from "../../../apps/server/src/orchestration-v2/threadHistoryPaging.ts";
import type {
  TaskListInput,
  TaskListResult,
  TaskMemoryEntry,
  TaskReadInput,
  TaskReadResult,
  TaskSearchInput,
  TaskSearchResult,
} from "./contracts.ts";
import * as TaskHandoffService from "./TaskHandoffService.ts";

type Scope = McpInvocationContext.McpInvocationScope;
const encodeTurnItem = Schema.encodeEffect(OrchestrationV2TurnItemJson);

export class TaskQueryService extends Context.Service<
  TaskQueryService,
  {
    readonly list: (
      scope: Scope,
      input: TaskListInput,
    ) => Effect.Effect<TaskListResult, OrchestratorMcpFailure>;
    readonly search: (
      scope: Scope,
      input: TaskSearchInput,
    ) => Effect.Effect<TaskSearchResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: Scope,
      input: TaskReadInput,
    ) => Effect.Effect<TaskReadResult, OrchestratorMcpFailure>;
  }
>()("@t3tools/ft3-orchestration/TaskQueryService") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The delegated task query could not be completed.",
  });

const notFound = () =>
  new OrchestratorMcpFailure({
    code: "task_not_found",
    message: "The delegated task was not found.",
  });

function statusForRun(
  status: OrchestrationV2RunStatus | undefined,
  task: OrchestrationV2Subagent,
): TaskMemoryEntry["latestStatus"] {
  const resolved = status ?? task.status;
  switch (resolved) {
    case "idle":
    case "pending":
    case "queued":
      return "queued";
    case "preparing":
    case "starting":
      return "running";
    case "rolled_back":
      return "cancelled";
    default:
      return resolved;
  }
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const handoffs = yield* TaskHandoffService.TaskHandoffService;

  const ownedTasks = Effect.fn("Ft3TaskQueryService.ownedTasks")(function* (scope: Scope) {
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Delegated task queries");
    if (!scope.capabilities.has("orchestration")) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot read delegated tasks.",
      });
    }
    const parent = yield* threads
      .getThreadShell(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null || parent.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    const { subagents } = yield* threads
      .getThreadRecords(parent.id, ["subagents"])
      .pipe(Effect.mapError(unavailable));
    const tasks = subagents
      .filter(
        (task) =>
          task.origin === "app_owned" && task.threadId === parent.id && task.childThreadId !== null,
      )
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { parent, tasks };
  });

  const loadEntry = Effect.fn("Ft3TaskQueryService.loadEntry")(function* (
    parent: Effect.Success<ReturnType<typeof ownedTasks>>["parent"],
    task: OrchestrationV2Subagent,
  ) {
    if (task.childThreadId === null) return null;
    const child = yield* threads
      .getThreadShell(task.childThreadId)
      .pipe(Effect.mapError(unavailable));
    if (
      child === null ||
      child.deletedAt !== null ||
      child.projectId !== parent.projectId ||
      child.lineage.parentThreadId !== parent.id ||
      child.lineage.relationshipToParent !== "subagent"
    )
      return null;
    const records = yield* threads
      .getThreadRecords(child.id, ["runs", "attempts", "providerTurns", "runtimeRequests"])
      .pipe(Effect.mapError(unavailable));
    const latestRun = records.runs
      .filter((run) => run.status !== "rolled_back")
      .toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const attempts = records.attempts.filter((attempt) => attempt.runId === latestRun?.id);
    const latestTurn = records.providerTurns
      .filter((turn) => attempts.some((attempt) => attempt.id === turn.runAttemptId))
      .toSorted((a, b) => {
        const left = attempts.find((attempt) => attempt.id === a.runAttemptId)!;
        const right = attempts.find((attempt) => attempt.id === b.runAttemptId)!;
        return right.attemptOrdinal - left.attemptOrdinal || b.ordinal - a.ordinal;
      })[0];
    const pending = records.runtimeRequests.some((request) => request.status === "pending");
    const entry: TaskMemoryEntry = {
      taskId: task.id,
      childThreadId: child.id,
      role: null,
      title: child.title.slice(0, 500),
      latestStatus: pending ? "waiting" : statusForRun(latestRun?.status, task),
      latestTurnId: latestTurn?.id ?? null,
      updatedAt: DateTime.formatIso(child.updatedAt),
      worktreePath: child.worktreePath,
      summary: null,
      handoff: yield* handoffs.get(task.id),
    };
    return entry;
  });

  const query = Effect.fn("Ft3TaskQueryService.query")(function* (
    scope: Scope,
    input: TaskListInput,
    search?: string,
  ) {
    const { parent, tasks } = yield* ownedTasks(scope);
    const limit = input.limit ?? 50;
    const candidates = tasks.filter(
      (task) => input.afterTaskId === undefined || task.id > input.afterTaskId,
    );
    const matches: TaskMemoryEntry[] = [];
    const batch = search === undefined ? candidates : candidates.slice(0, 500);
    let cursor: NodeId | null = null;
    for (const task of batch) {
      const entry = yield* loadEntry(parent, task);
      cursor = task.id;
      if (entry === null) continue;
      const folded = search?.toLocaleLowerCase();
      if (
        search !== undefined &&
        task.id !== search &&
        entry.childThreadId !== search &&
        entry.latestTurnId !== search &&
        entry.latestStatus !== search &&
        entry.worktreePath !== search &&
        ![entry.title, entry.worktreePath ?? "", task.result ?? ""]
          .join("\n")
          .toLocaleLowerCase()
          .includes(folded!)
      )
        continue;
      matches.push(entry);
      if (matches.length > limit) break;
    }
    const page = matches.slice(0, limit);
    return {
      tasks: page,
      nextCursor:
        matches.length > limit
          ? page.at(-1)!.taskId
          : batch.length < candidates.length
            ? cursor
            : null,
    } satisfies TaskListResult;
  });

  return TaskQueryService.of({
    list: query,
    search: Effect.fn("Ft3TaskQueryService.search")(function* (scope, input) {
      const queryText = input.query.trim();
      return { query: queryText, ...(yield* query(scope, input, queryText)) };
    }),
    read: Effect.fn("Ft3TaskQueryService.read")(function* (scope, input) {
      const { parent, tasks } = yield* ownedTasks(scope);
      const task = tasks.find((task) => task.id === input.taskId);
      if (task === undefined) return yield* notFound();
      const entry = yield* loadEntry(parent, task);
      if (entry === null) return yield* notFound();
      let history: OrchestrationV2ThreadHistoryPage;
      if (input.beforeCursor === undefined) {
        const snapshot = yield* threads
          .getThreadSnapshotWindow(entry.childThreadId, {
            rowLimit: THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 2,
            userTurnLimit: (input.turnLimit ?? 8) + 1,
          })
          .pipe(Effect.mapError(unavailable));
        history = {
          snapshotSequence: snapshot.snapshotSequence,
          items: snapshot.projection.visibleTurnItems,
          nextCursor: null,
          hasMoreHistory: false,
        };
      } else {
        yield* Effect.try({
          try: () => decodeThreadHistoryCursor(input.beforeCursor!),
          catch: () =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Invalid transcript cursor.",
            }),
        });
        history = yield* threads
          .getThreadHistoryPage(entry.childThreadId, input.beforeCursor)
          .pipe(Effect.mapError(unavailable));
      }
      const window = selectRecentTimelineWindow({
        items: history.items,
        snapshotSequence: history.snapshotSequence,
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: input.turnLimit ?? 8 },
      });
      const messageIdsByThread = new Map<ThreadId, MessageId[]>();
      for (const row of window.items) {
        if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
        const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
        ids.push(row.item.messageId);
        messageIdsByThread.set(row.sourceThreadId, ids);
      }
      const sourceMessages = new Map(
        yield* Effect.forEach([...messageIdsByThread], ([threadId, messageIds]) =>
          threads.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
            Effect.map(
              (records) =>
                [
                  threadId,
                  new Map(records.messages.map((message) => [message.id, message])),
                ] as const,
            ),
            Effect.mapError(unavailable),
          ),
        ),
      );
      const messages: TaskReadResult["messages"][number][] = [];
      const activities: TaskReadResult["activities"][number][] = [];
      for (const { item, sourceThreadId } of window.items) {
        const createdAt = item.startedAt === null ? null : DateTime.formatIso(item.startedAt);
        if (item.type === "user_message" || item.type === "assistant_message") {
          const message = sourceMessages.get(sourceThreadId)?.get(item.messageId);
          messages.push({
            id: item.messageId,
            role: item.type === "user_message" ? "user" : "assistant",
            text: item.text,
            ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
            ...(item.type === "user_message" && item.context !== undefined
              ? { context: item.context }
              : {}),
            turnId: item.providerTurnId,
            streaming: item.type === "assistant_message" && item.streaming,
            createdAt: message === undefined ? createdAt : DateTime.formatIso(message.createdAt),
            updatedAt: DateTime.formatIso(item.updatedAt),
          });
        } else {
          const payload = yield* encodeTurnItem(item).pipe(Effect.mapError(unavailable));
          activities.push({
            id: EventId.make(item.id),
            tone:
              item.type === "error"
                ? "error"
                : item.type === "approval_request"
                  ? "approval"
                  : "tool",
            kind: item.type,
            summary: item.title?.trim() || item.type,
            payload,
            turnId: item.providerTurnId,
            createdAt,
          });
        }
      }
      return {
        taskId: entry.taskId,
        title: entry.title,
        handoff: entry.handoff,
        messages,
        activities,
        page: {
          beforeCursor: window.hasMoreHistory ? window.nextCursor : history.nextCursor,
          hasMore: window.hasMoreHistory || history.hasMoreHistory,
          snapshotSequence: history.snapshotSequence,
          threadSequence: history.snapshotSequence,
        },
      };
    }),
  });
});

export const layer = Layer.effect(TaskQueryService, make);
