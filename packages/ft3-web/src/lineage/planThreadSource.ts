import type { ThreadId } from "@t3tools/contracts";
import type { BoardCardId } from "@t3tools/ft3-board/contracts";

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
  readonly implementStarted: boolean;
}

/** Returns only plans that already have a planner thread. */
export interface PlanThreadSource {
  readonly forCard: (cardId: BoardCardId) => PlanThread | null;
  readonly forOrchestratorThread: (threadId: ThreadId) => ReadonlyArray<PlanThread>;
}

const noPlanThreads: PlanThreadSource = {
  forCard: () => null,
  forOrchestratorThread: () => [],
};

// Stub until the planning RPC supplies plans; the lineage row and the card button read only this.
export function usePlanThreadSource(): PlanThreadSource {
  return noPlanThreads;
}
