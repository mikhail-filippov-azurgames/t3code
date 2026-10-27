import { EnvironmentId, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";
import { TaskSummaryHistoryResult } from "../../ft3-orchestration/src/contracts.ts";
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

  return BoardSummaryHistoryService.of({
    history: Effect.fn("Ft3BoardSummaryHistoryService.history")(function* (input) {
      const { parentThreadId, ...page } = input;
      return yield* taskQueries
        .history(summaryHistoryScope(parentThreadId, yield* Clock.currentTimeMillis), page)
        .pipe(
          Effect.mapError(
            (error) => new Contracts.BoardMcpFailure({ code: error.code, message: error.message }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(BoardSummaryHistoryService, make);
