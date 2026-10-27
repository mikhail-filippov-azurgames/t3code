import { assert, describe, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";
import type { TaskSummaryHistoryResult } from "../../ft3-orchestration/src/contracts.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardSummaryHistoryService from "./BoardSummaryHistoryService.ts";
import * as Contracts from "./contracts.ts";

const coordinatorId = ThreadId.make("coordinator");
const executorId = ThreadId.make("executor");
const completedAt = "2026-10-26T00:00:00.000Z";

const card: Contracts.BoardCard = {
  cardId: Contracts.BoardCardId.make("11111111-1111-4111-8111-111111111111"),
  orchestratorThreadId: coordinatorId,
  title: "Аудит новой графики Workshop",
  body: "",
  status: "done",
  readiness: "ready",
  readinessNote: null,
  createdBy: "orchestrator",
  assignee: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-4-5" },
  executorRole: "research",
  executorThreadId: executorId,
  outcome: "succeeded",
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: completedAt,
  updatedAt: completedAt,
};

function record(
  overrides: Partial<TaskSummaryHistoryResult["records"][number]> = {},
): TaskSummaryHistoryResult["records"][number] {
  return {
    childThreadId: executorId,
    sourceTurnId: TurnId.make("turn:one"),
    completedAt,
    summaryText: "Outcome: audit recorded.",
    summaryState: "ready",
    summaryWatermark: 4,
    currentTurnId: null,
    currentTurnState: "completed",
    currentWatermark: 4,
    childTitle: "delegated-task:1111",
    executorRole: "",
    executorProviderInstanceId: "claudeAgent",
    executorModel: "claude-opus-4-1",
    stale: false,
    ...overrides,
  };
}

function dependencies(input: {
  readonly records: ReadonlyArray<TaskSummaryHistoryResult["records"][number]>;
  readonly card: Contracts.BoardCard | null;
  readonly requestedThreadIds: Array<string>;
}) {
  return Layer.mergeAll(
    Layer.mock(BoardRepository.BoardRepository)({
      getCardByExecutorThreadId: (threadId) =>
        Effect.sync(() => {
          input.requestedThreadIds.push(String(threadId));
          return input.card;
        }),
    }),
    Layer.mock(TaskQueryService.TaskQueryService)({
      history: (_scope, _input) => Effect.succeed({ records: input.records, nextCursor: null }),
    }),
  );
}

function unavailableHistoryDependencies(error: OrchestratorMcpFailure) {
  return Layer.mergeAll(
    Layer.mock(BoardRepository.BoardRepository)({
      getCardByExecutorThreadId: () => Effect.succeed(null),
    }),
    Layer.mock(TaskQueryService.TaskQueryService)({
      history: () => Effect.fail(error),
    }),
  );
}

describe("BoardSummaryHistoryService", () => {
  it.effect("names the child by its card and fills the executor from the card", () => {
    const requestedThreadIds: Array<string> = [];
    return Effect.gen(function* () {
      const history = yield* BoardSummaryHistoryService.BoardSummaryHistoryService;
      const page = yield* history.history({ parentThreadId: coordinatorId });
      assert.deepStrictEqual(requestedThreadIds, [String(executorId)]);
      const entry = page.records[0]!;
      assert.equal(entry.childTitle, card.title);
      assert.equal(entry.executorRole, "research");
      assert.equal(entry.executorProviderInstanceId, "claudeAgent");
      assert.equal(entry.executorModel, "claude-opus-4-1");
      assert.equal(entry.currentTurnState, "completed");
    }).pipe(
      Effect.provide(
        BoardSummaryHistoryService.layer.pipe(
          Layer.provide(dependencies({ records: [record()], card, requestedThreadIds })),
        ),
      ),
    );
  });

  it.effect("returns an empty page for a parent thread the server has not persisted", () => {
    return Effect.gen(function* () {
      const history = yield* BoardSummaryHistoryService.BoardSummaryHistoryService;
      const page = yield* history.history({ parentThreadId: ThreadId.make("draft-thread") });
      assert.deepStrictEqual(page, { records: [], nextCursor: null });
    }).pipe(
      Effect.provide(
        BoardSummaryHistoryService.layer.pipe(
          Layer.provide(
            unavailableHistoryDependencies(
              new OrchestratorMcpFailure({
                code: "thread_not_found",
                message: "The calling thread was not found.",
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("keeps a real orchestration failure visible", () => {
    return Effect.gen(function* () {
      const history = yield* BoardSummaryHistoryService.BoardSummaryHistoryService;
      const error = yield* history.history({ parentThreadId: coordinatorId }).pipe(Effect.flip);
      assert.equal(error.code, "orchestration_error");
    }).pipe(
      Effect.provide(
        BoardSummaryHistoryService.layer.pipe(
          Layer.provide(
            unavailableHistoryDependencies(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "The delegated task query could not be completed.",
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("keeps the thread facts when no card owns the child", () => {
    return Effect.gen(function* () {
      const history = yield* BoardSummaryHistoryService.BoardSummaryHistoryService;
      const page = yield* history.history({ parentThreadId: coordinatorId });
      assert.equal(page.records[0]!.childTitle, "delegated-task:1111");
      assert.equal(page.records[0]!.executorRole, "");
      assert.equal(page.records[0]!.executorModel, "claude-opus-4-1");
    }).pipe(
      Effect.provide(
        BoardSummaryHistoryService.layer.pipe(
          Layer.provide(dependencies({ records: [record()], card: null, requestedThreadIds: [] })),
        ),
      ),
    );
  });
});
