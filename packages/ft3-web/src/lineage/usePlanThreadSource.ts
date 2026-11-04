import type { EnvironmentId } from "@t3tools/contracts";

import { useMemo } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { boardEnvironment } from "../board/state.ts";
import {
  noPlanThreads,
  planThreadsFromBoardList,
  type PlanThreadSource,
} from "./planThreadSource.ts";

/**
 * Plans from the board card list response, without an extra request per card.
 * The card list atom is shared with the board page, so the lineage panel and
 * the card button usually read its cached value.
 */
export function usePlanThreadSource(environmentId: EnvironmentId | null): PlanThreadSource {
  const query = useEnvironmentQuery(
    environmentId === null ? null : boardEnvironment.list({ environmentId, input: {} }),
  );
  const threads = useMemo(() => planThreadsFromBoardList(query.data ?? null), [query.data]);
  return useMemo(() => {
    if (threads.length === 0) return noPlanThreads;
    const byCard = new Map(threads.map((plan) => [String(plan.cardId), plan]));
    const byOrchestrator = new Map<string, (typeof threads)[number][]>();
    for (const plan of threads) {
      const key = String(plan.orchestratorThreadId);
      const group = byOrchestrator.get(key);
      if (group === undefined) byOrchestrator.set(key, [plan]);
      else group.push(plan);
    }
    return {
      forCard: (cardId) => byCard.get(String(cardId)) ?? null,
      forOrchestratorThread: (threadId) => byOrchestrator.get(String(threadId)) ?? [],
    };
  }, [threads]);
}
