import { assert, describe, it } from "@effect/vitest";
import { NodeId, ProviderTurnId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TaskQueryService from "../../ft3-orchestration/src/TaskQueryService.ts";
import * as BoardDelegationService from "./BoardDelegationService.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";

const cardId = Contracts.BoardCardId.make("11111111-1111-4111-8111-111111111111");
const coordinatorId = ThreadId.make("coordinator");
const executorId = ThreadId.make("executor");
const updatedAt = "2026-10-26T00:00:00.000Z";

const card = {
  cardId,
  orchestratorThreadId: coordinatorId,
  title: "Ship the board slice",
  body: "",
  status: "in_progress" as const,
  readiness: "ready" as const,
  readinessNote: null,
  createdBy: "human" as const,
  assignee: null,
  executorRole: "implementation" as const,
  executorThreadId: executorId as ThreadId | null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: updatedAt,
  updatedAt,
};

function fixture(input: {
  readonly card: typeof card;
  readonly calls: Array<{ scope: unknown; input: unknown }>;
}) {
  return Layer.mergeAll(
    Layer.mock(BoardRepository.BoardRepository)({
      getCard: (id) => Effect.succeed(id === input.card.cardId ? input.card : null),
    }),
    Layer.mock(TaskQueryService.TaskQueryService)({
      list: (scope, query) =>
        Effect.sync(() => {
          input.calls.push({ scope, input: query });
          return {
            tasks: [
              {
                taskId: NodeId.make("task:one"),
                childThreadId: ThreadId.make("executor-child"),
                role: null,
                title: "Probe the parser",
                latestStatus: "completed" as const,
                latestTurnId: ProviderTurnId.make("turn:one"),
                updatedAt,
                worktreePath: null,
                summary: {
                  text: "Parser probe passed.",
                  source: "deterministic",
                  sourceTurnIds: [],
                  watermark: 1,
                  stale: false,
                  state: "ready",
                  error: null,
                },
                handoff: null,
              },
            ],
            nextCursor: NodeId.make("task:one"),
          };
        }),
    }),
  );
}

describe("BoardDelegationService", () => {
  it.effect("returns no delegations before a card has an executor", () => {
    const calls: Array<{ scope: unknown; input: unknown }> = [];
    const withoutExecutor = { ...card, executorThreadId: null };
    return Effect.gen(function* () {
      const service = yield* BoardDelegationService.BoardDelegationService;
      const result = yield* service.list({ cardId });
      assert.deepEqual(result, { delegations: [], nextCursor: null });
      assert.deepEqual(calls, []);
    }).pipe(
      Effect.provide(
        BoardDelegationService.layer.pipe(Layer.provide(fixture({ card: withoutExecutor, calls }))),
      ),
    );
  });

  it.effect("reads the card executor subagents through TaskQueryService", () => {
    const calls: Array<{ scope: unknown; input: unknown }> = [];
    return Effect.gen(function* () {
      const service = yield* BoardDelegationService.BoardDelegationService;
      const result = yield* service.list({
        cardId,
        afterTaskId: NodeId.make("task:zero"),
        limit: 10,
      });
      assert.deepEqual(result, {
        delegations: [
          {
            taskId: NodeId.make("task:one"),
            childThreadId: ThreadId.make("executor-child"),
            title: "Probe the parser",
            latestStatus: "completed",
            latestTurnId: ProviderTurnId.make("turn:one"),
            updatedAt,
            summary: "Parser probe passed.",
          },
        ],
        nextCursor: NodeId.make("task:one"),
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.input, { limit: 10, afterTaskId: NodeId.make("task:zero") });
      const scope = calls[0]!.scope as {
        readonly capabilities: ReadonlySet<string>;
        readonly thread: { readonly threadId: ThreadId };
      };
      assert.isTrue(scope.capabilities.has("orchestration"));
      assert.equal(scope.thread.threadId, executorId);
    }).pipe(
      Effect.provide(BoardDelegationService.layer.pipe(Layer.provide(fixture({ card, calls })))),
    );
  });
});
