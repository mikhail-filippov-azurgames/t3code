import type { ScopedThreadRef } from "@t3tools/contracts";
import type { BoardCardId, BoardCardLookupDetail } from "@t3tools/ft3-board/contracts";
import { useEffect, useMemo, useSyncExternalStore, type UIEvent } from "react";

interface CardsPanelState {
  readonly selectedPlanId: BoardCardId | null;
  readonly selectedPlanTitle: string | undefined;
  readonly collapsed: boolean;
  readonly descriptionExpanded: boolean;
  readonly historyExpanded: boolean;
  readonly requestText: string;
}

const initialState: CardsPanelState = {
  selectedPlanId: null,
  selectedPlanTitle: undefined,
  collapsed: false,
  descriptionExpanded: false,
  historyExpanded: false,
  requestText: "",
};

// Session-only viewing state survives tab changes and panel remounts.
const entries = new Map<string, ReturnType<typeof createEntry>>();

function createEntry() {
  let state = initialState;
  let detail: BoardCardLookupDetail | undefined;
  let leadMembership: boolean | undefined;
  let scrollTop = 0;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (patch: Partial<CardsPanelState>) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    getDetail: () => detail,
    getLeadMembership: () => leadMembership,
    retainLeadMembership: (value: boolean) => {
      leadMembership = value;
    },
    retainDetail: (value: BoardCardLookupDetail) => {
      detail = value;
    },
    restoreScroll: (node: HTMLDivElement | null) => {
      if (node !== null) node.scrollTop = scrollTop;
    },
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      scrollTop = event.currentTarget.scrollTop;
    },
  };
}

export function useCardsPanelState(ref: ScopedThreadRef, cardId: string = "") {
  const entry = useMemo(() => {
    const key = JSON.stringify([ref.environmentId, ref.threadId, cardId]);
    let value = entries.get(key);
    if (value === undefined) {
      value = createEntry();
      entries.set(key, value);
    }
    return value;
  }, [ref.environmentId, ref.threadId, cardId]);
  const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot, () => initialState);
  return { state, update: entry.update, entry };
}

export function useRetainedCardDetail(
  entry: ReturnType<typeof useCardsPanelState>["entry"],
  detail: BoardCardLookupDetail | undefined,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the last committed card detail in the session registry across query resets and panel remounts
  useEffect(() => {
    if (detail !== undefined) entry.retainDetail(detail);
  }, [entry, detail]);
  return detail ?? entry.getDetail();
}
