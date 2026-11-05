import type { ThreadId } from "@t3tools/contracts";
import type { BoardCardId, BoardCardPlanSummary } from "@t3tools/ft3-board/contracts";

export type PlanState =
  | "required"
  | "drafting"
  | "reviewing"
  | "discussion"
  | "accepted"
  | "withdrawn";

export interface PlanThread {
  readonly cardId: BoardCardId;
  readonly title: string;
  readonly orchestratorThreadId: ThreadId;
  readonly plannerThreadId: ThreadId;
  readonly state: PlanState;
  readonly implementStarted: boolean | null;
}

/** Returns only plans that already have a planner thread. */
export interface PlanThreadSource {
  readonly forCard: (cardId: BoardCardId) => PlanThread | null;
  readonly forOrchestratorThread: (threadId: ThreadId) => ReadonlyArray<PlanThread>;
}

/** The board list slice the plan summaries are read from. */
export interface PlanThreadBoardList {
  readonly cards: ReadonlyArray<{
    readonly cardId: BoardCardId;
    readonly orchestratorThreadId: ThreadId;
  }>;
  readonly plans: ReadonlyArray<BoardCardPlanSummary>;
}

/**
 * Joins the plan summaries of the board card list response with their cards.
 * Plans without a planner thread or without a card stay out: the row and the
 * card button both open the planner thread, so there is nothing to show yet.
 */
export function planThreadsFromBoardList(
  result: PlanThreadBoardList | null,
): ReadonlyArray<PlanThread> {
  if (result === null) return [];
  const orchestratorByCard = new Map(
    result.cards.map((card) => [String(card.cardId), card.orchestratorThreadId]),
  );
  const threads: PlanThread[] = [];
  for (const plan of result.plans) {
    if (plan.plannerThreadId === null) continue;
    const orchestratorThreadId = orchestratorByCard.get(String(plan.cardId));
    if (orchestratorThreadId === undefined) continue;
    threads.push({
      cardId: plan.cardId,
      title: plan.title,
      orchestratorThreadId,
      plannerThreadId: plan.plannerThreadId,
      state: plan.status,
      // Set by the server once a plan.phase=implement letter exists; the pin
      // logic drops the accepted row and shows the planner thread normally.
      implementStarted: plan.implementStarted,
    });
  }
  return threads;
}

export const noPlanThreads: PlanThreadSource = {
  forCard: () => null,
  forOrchestratorThread: () => [],
};
