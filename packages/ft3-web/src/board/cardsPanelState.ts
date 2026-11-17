import type { ScopedThreadRef } from "@t3tools/contracts";
import type { BoardCardId, BoardCardLookupDetail } from "@t3tools/ft3-board/contracts";
import { useEffect, useSyncExternalStore, type UIEvent } from "react";

interface CardsPanelState {
  readonly selectedPlanId: BoardCardId | null;
  readonly collapsed: boolean;
  readonly descriptionExpanded: boolean;
  readonly historyExpanded: boolean;
  readonly requestText: string;
}

const initialState: CardsPanelState = {
  selectedPlanId: null,
  collapsed: false,
  descriptionExpanded: false,
  historyExpanded: false,
  requestText: "",
};

const THREAD_LIMIT = 50;
// Active panels keep their entries. Inactive threads are evicted in LRU order.
const threads = new Map<
  string,
  {
    panel: ReturnType<typeof createEntry>;
    cards: Map<string, ReturnType<typeof createEntry>>;
  }
>();

function pruneThreads(protectedKey?: string) {
  for (const [key, thread] of threads) {
    if (threads.size <= THREAD_LIMIT) return;
    if (
      key !== protectedKey &&
      !thread.panel.isObserved() &&
      !Array.from(thread.cards.values()).some((entry) => entry.isObserved())
    ) {
      threads.delete(key);
    }
  }
}

function createEntry() {
  let state = initialState;
  let detail: BoardCardLookupDetail | undefined;
  let leadMembership: boolean | undefined;
  let scrollTop = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    isObserved: () => listeners.size > 0,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        pruneThreads();
      };
    },
    update: (patch: Partial<CardsPanelState>) => {
      state = { ...state, ...patch };
      notify();
    },
    reset: () => {
      state = initialState;
      detail = undefined;
      leadMembership = undefined;
      scrollTop = 0;
      notify();
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

const emptyEntry = createEntry();
const threadKey = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);

export function getCardsPanelState(ref: ScopedThreadRef, cardId: string = "") {
  const key = threadKey(ref);
  let thread = threads.get(key);
  if (thread === undefined) thread = { panel: createEntry(), cards: new Map() };
  threads.delete(key);
  threads.set(key, thread);
  let entry = cardId === "" ? thread.panel : thread.cards.get(cardId);
  if (entry === undefined) {
    entry = createEntry();
    thread.cards.set(cardId, entry);
  }
  pruneThreads(key);
  return entry;
}

export function readCardsPanelDetail(ref: ScopedThreadRef, cardId: string) {
  return threads.get(threadKey(ref))?.cards.get(cardId)?.getDetail();
}

export function removeCardsPanelCard(ref: ScopedThreadRef, cardId: string) {
  const thread = threads.get(threadKey(ref));
  if (thread === undefined) return;
  const entry = thread.cards.get(cardId);
  thread.cards.delete(cardId);
  entry?.reset();
  if (thread.panel.getSnapshot().selectedPlanId === cardId) {
    thread.panel.update({ selectedPlanId: null });
  }
}

export function retainCardsPanelPins(ref: ScopedThreadRef, cardIds: readonly string[]) {
  const thread = threads.get(threadKey(ref));
  if (thread === undefined) return;
  for (const cardId of thread.cards.keys()) {
    if (!cardIds.includes(cardId)) removeCardsPanelCard(ref, cardId);
  }
  const selectedPlanId = thread.panel.getSnapshot().selectedPlanId;
  if (selectedPlanId !== null && !cardIds.includes(selectedPlanId)) {
    removeCardsPanelCard(ref, selectedPlanId);
  }
}

export function resetCardsPanelState() {
  for (const thread of threads.values()) {
    thread.panel.reset();
    for (const entry of thread.cards.values()) entry.reset();
  }
  threads.clear();
}

export function useCardsPanelState(ref: ScopedThreadRef, cardId: string = "", enabled = true) {
  const entry = enabled ? getCardsPanelState(ref, cardId) : emptyEntry;
  const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot, () => initialState);
  return { state, update: entry.update, entry };
}

export function useRetainedCardDetail(
  entry: ReturnType<typeof getCardsPanelState>,
  detail: BoardCardLookupDetail | undefined,
  retain: boolean,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the last committed card detail in the session registry across query resets and panel remounts
  useEffect(() => {
    if (detail !== undefined) entry.retainDetail(detail);
  }, [entry, detail]);
  return detail ?? (retain ? entry.getDetail() : undefined);
}
