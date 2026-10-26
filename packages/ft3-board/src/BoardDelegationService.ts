import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";
import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";

const unavailable = () =>
  new Contracts.BoardMcpFailure({
    code: "orchestration_error",
    message: "The board delegation query could not be completed.",
  });

const notFound = () =>
  new Contracts.BoardMcpFailure({
    code: "task_not_found",
    message: "The board card was not found.",
  });

// TaskQueryService inspects only the capability set and the caller thread id.
const executorDelegationsScope = (
  executorThreadId: ThreadId,
  cardId: string,
  issuedAt: number,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("ft3-board"),
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  issuedAt,
  requestNamespace: `ft3:board:executor-delegations:${cardId}`,
  thread: {
    threadId: executorThreadId,
    providerSessionId: ProviderSessionId.make(`ft3-board:${executorThreadId}`),
    providerInstanceId: ProviderInstanceId.make("board"),
  },
  client: undefined,
});

export class BoardDelegationService extends Context.Service<
  BoardDelegationService,
  {
    readonly list: (
      input: Contracts.BoardExecutorDelegationsInput,
    ) => Effect.Effect<Contracts.BoardExecutorDelegationsResult, Contracts.BoardMcpFailure>;
  }
>()("@t3tools/ft3-board/BoardDelegationService") {}

const make = Effect.gen(function* () {
  const repo = yield* BoardRepository.BoardRepository;
  const taskQueries = yield* TaskQueryService.TaskQueryService;

  return BoardDelegationService.of({
    list: Effect.fn("Ft3BoardDelegationService.list")(function* (input) {
      const card = yield* repo.getCard(input.cardId).pipe(Effect.mapError(unavailable));
      if (card === null) return yield* notFound();
      const executorThreadId = card.executorThreadId;
      if (executorThreadId === null) return { delegations: [], nextCursor: null };
      const scope = executorDelegationsScope(
        executorThreadId,
        card.cardId,
        yield* Clock.currentTimeMillis,
      );
      const page = yield* taskQueries
        .list(scope, {
          limit: input.limit ?? 50,
          ...(input.afterTaskId === undefined ? {} : { afterTaskId: input.afterTaskId }),
        })
        .pipe(Effect.mapError(unavailable));
      return {
        delegations: page.tasks.map((task) => ({
          taskId: task.taskId,
          childThreadId: task.childThreadId,
          title: task.title,
          latestStatus: task.latestStatus,
          latestTurnId: task.latestTurnId,
          updatedAt: task.updatedAt,
          summary: task.summary?.text ?? null,
        })),
        nextCursor: page.nextCursor,
      };
    }),
  });
});

export const layer = Layer.effect(BoardDelegationService, make);
