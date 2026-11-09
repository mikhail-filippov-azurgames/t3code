import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BoardService from "./BoardService.ts";
import * as Contracts from "./contracts.ts";
import { PlanService } from "./PlanService.ts";
import { boardRpcHandlers, FT3_BOARD_WS_METHODS } from "./rpc.ts";

const epoch = "2026-11-06T00:00:00.000Z";
const card = (cardId: string, orchestratorThreadId: string): Contracts.BoardCard =>
  ({
    cardId: cardId as Contracts.BoardCardId,
    orchestratorThreadId: ThreadId.make(orchestratorThreadId),
    title: cardId,
    body: "",
    status: "todo",
    readiness: "ready",
    readinessNote: null,
    createdBy: "human",
    assignee: null,
    executorRole: "implementation",
    executorThreadId: null,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: 0,
    archived: false,
    createdAt: epoch,
    updatedAt: epoch,
  }) as Contracts.BoardCard;

const lookupMatch = (value: Contracts.BoardCard): Contracts.BoardCardLookupMatch => ({
  token: "deadbeef" as Contracts.BoardCardLookupToken,
  card: value,
  orchestratorThreadTitle: null,
  recentEvents: [],
});

const lookupDetail = (value: Contracts.BoardCard): Contracts.BoardCardLookupDetail => ({
  card: value,
  orchestratorThreadTitle: null,
  events: [],
});

const services = (
  resolved: Contracts.BoardCardResolveResult = { matches: [], details: [] },
  environmentBoardEnabled = false,
) => {
  const projectEnabled: Readonly<Record<string, boolean>> = {
    "thread:off": false,
    "thread:on": true,
  };
  return Layer.mergeAll(
    Layer.mock(BoardService.BoardService)({
      requireFeature: ({ threadId }) => {
        const enabled =
          threadId === undefined
            ? environmentBoardEnabled
            : (projectEnabled[String(threadId)] ?? environmentBoardEnabled);
        return enabled
          ? Effect.void
          : Effect.fail(
              new Contracts.BoardMcpFailure({
                code: "feature_disabled",
                message: "Board is disabled.",
              }),
            );
      },
      listOrchestrators: () => Effect.succeed({ orchestrators: [] }),
      listBoard: () => Effect.succeed({ cards: [], events: [] }),
      resolveCards: () => Effect.succeed(resolved),
    }),
    Layer.mock(PlanService)({ listSummaries: () => Effect.succeed([]) }),
  );
};

describe("board RPC project feature visibility", () => {
  it.effect(
    "keeps board and orchestrator listings available when the environment board is off",
    () =>
      Effect.gen(function* () {
        const orchestrators =
          yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardOrchestratorsList]();
        const board = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardList]({});

        assert.deepStrictEqual(orchestrators.orchestrators, []);
        assert.deepStrictEqual(board.cards, []);
      }).pipe(Effect.provide(services())),
  );

  it.effect(
    "filters disabled project cards from resolve and uses the environment for unknown threads",
    () => {
      const off = card("card:off", "thread:off");
      const on = card("card:on", "thread:on");
      const unknown = card("card:unknown", "thread:unknown");
      const resolved: Contracts.BoardCardResolveResult = {
        matches: [lookupMatch(off), lookupMatch(on), lookupMatch(unknown)],
        details: [lookupDetail(off), lookupDetail(on), lookupDetail(unknown)],
      };
      return Effect.gen(function* () {
        const result = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardResolve]({
          tokens: [],
          cardIds: [],
        });

        assert.deepStrictEqual(
          result.matches.map((match) => match.card.cardId),
          ["card:on", "card:unknown"],
        );
        assert.deepStrictEqual(
          result.details.map((detail) => detail.card.cardId),
          ["card:on", "card:unknown"],
        );
      }).pipe(Effect.provide(services(resolved, true)));
    },
  );
});
