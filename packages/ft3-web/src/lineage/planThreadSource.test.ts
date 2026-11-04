import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { BoardCardId } from "@t3tools/ft3-board/contracts";

import { planThreadsFromBoardList } from "./planThreadSource.ts";

const cardId = BoardCardId.make("11111111-1111-4111-8111-111111111111");
const lead = ThreadId.make("lead");
const planner = ThreadId.make("planner");

function list(
  overrides: Partial<Parameters<typeof planThreadsFromBoardList>[0]> & {
    readonly plan?: object;
  } = {},
) {
  const { plan, ...rest } = overrides;
  return {
    cards: [{ cardId, orchestratorThreadId: lead }],
    plans: [
      {
        cardId,
        planDocId: "22222222-2222-4222-8222-222222222222",
        title: "Ship the board",
        status: "discussion" as const,
        stepCount: 2,
        plannerThreadId: planner,
        ...plan,
      },
    ],
    ...rest,
  };
}

describe("planThreadsFromBoardList", () => {
  it("joins each plan summary with its card", () => {
    const [thread] = planThreadsFromBoardList(list());
    expect(thread).toEqual({
      cardId,
      title: "Ship the board",
      orchestratorThreadId: lead,
      plannerThreadId: planner,
      state: "discussion",
      implementStarted: false,
    });
  });

  it("returns no threads without a board list", () => {
    expect(planThreadsFromBoardList(null)).toEqual([]);
  });

  it("skips plans that have no planner thread yet", () => {
    expect(planThreadsFromBoardList(list({ plan: { plannerThreadId: null } }))).toEqual([]);
  });

  it("skips plans whose card is not in the list", () => {
    expect(planThreadsFromBoardList(list({ cards: [] }))).toEqual([]);
  });
});
