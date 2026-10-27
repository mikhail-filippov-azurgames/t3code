import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";
import { TaskSummaryHistoryResult } from "../../ft3-orchestration/src/contracts.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";

// TaskQueryService inspects only the capability set and the caller thread id.
const summaryHistoryScope = (
  parentThreadId: Contracts.BoardDelegatedTaskSummaryHistoryInput["parentThreadId"],
  issuedAt: number,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("ft3-board"),
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  issuedAt,
  requestNamespace: `ft3:board:summary-history:${parentThreadId}`,
  thread: {
    threadId: parentThreadId,
    providerSessionId: ProviderSessionId.make(`ft3-board:${parentThreadId}`),
    providerInstanceId: ProviderInstanceId.make("board"),
  },
  client: undefined,
});

export class BoardSummaryHistoryService extends Context.Service<
  BoardSummaryHistoryService,
  {
    readonly history: (
      input: Contracts.BoardDelegatedTaskSummaryHistoryInput,
    ) => Effect.Effect<TaskSummaryHistoryResult, Contracts.BoardMcpFailure>;
  }
>()("@t3tools/ft3-board/BoardSummaryHistoryService") {}

const make = Effect.gen(function* () {
  const taskQueries = yield* TaskQueryService.TaskQueryService;
  const cards = yield* BoardRepository.BoardRepository;

  return BoardSummaryHistoryService.of({
    history: Effect.fn("Ft3BoardSummaryHistoryService.history")(function* (input) {
      const { parentThreadId, ...page } = input;
      const result = yield* taskQueries
        .history(summaryHistoryScope(parentThreadId, yield* Clock.currentTimeMillis), page)
        .pipe(
          // The panel also requests history for a draft the server has not persisted yet: no
          // thread means no summaries, not a failure. Real read errors still surface.
          Effect.catchIf(
            (error) => error.code === "thread_not_found",
            () =>
              Effect.succeed({ records: [], nextCursor: null } satisfies TaskSummaryHistoryResult),
          ),
          Effect.mapError(
            (error) => new Contracts.BoardMcpFailure({ code: error.code, message: error.message }),
          ),
        );
      // A delegated child thread can be hidden from the client, so the card is the human-facing name.
      const records = yield* Effect.forEach(
        result.records,
        (record) =>
          Effect.gen(function* () {
            const card = yield* cards
              .getCardByExecutorThreadId(ThreadId.make(record.childThreadId))
              .pipe(
                Effect.mapError(
                  (error) =>
                    new Contracts.BoardMcpFailure({
                      code: "orchestration_error",
                      message: `The board card for this task could not be read: ${error.operation}.`,
                    }),
                ),
              );
            if (card === null) return record;
            const assignee = card.assignee;
            return {
              ...record,
              childTitle: card.title,
              executorRole: card.executorRole,
              executorProviderInstanceId:
                record.executorProviderInstanceId ??
                (assignee === null ? null : String(assignee.instanceId)),
              executorModel: record.executorModel ?? assignee?.model ?? null,
            };
          }),
        { concurrency: 8 },
      );
      return { ...result, records };
    }),
  });
});

export const layer = Layer.effect(BoardSummaryHistoryService, make);
