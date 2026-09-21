/**
 * Pure board math and copy for the orchestrator kanban page.
 *
 * The server owns cards, statuses, and the append-only progress history. The
 * client only groups, filters, and renders; it never invents a card or moves one
 * between columns, because the human cannot change a card's status or executor
 * (design §5).
 *
 * @module components/board/board.logic
 */
import type {
  BoardCard,
  BoardCardEvent,
  BoardCardStatus,
  BoardExecutorRole,
  BoardListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

export const BOARD_COLUMNS: ReadonlyArray<{
  readonly status: BoardCardStatus;
  readonly label: string;
}> = [
  { status: "todo", label: "To do" },
  { status: "orchestrator", label: "Orchestrator" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export const BOARD_EXECUTOR_ROLES: ReadonlyArray<BoardExecutorRole> = [
  "architecture",
  "implementation",
  "review",
  "test",
  "research",
  "general",
];

const STATUS_LABELS: Readonly<Record<BoardCardStatus, string>> = {
  todo: "To do",
  orchestrator: "Orchestrator",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

const ROLE_LABELS: Readonly<Record<BoardExecutorRole, string>> = {
  architecture: "Architecture",
  implementation: "Implementation",
  review: "Review",
  test: "Test",
  research: "Research",
  general: "General",
};

export function boardStatusLabel(status: BoardCardStatus): string {
  return STATUS_LABELS[status];
}

export function boardExecutorRoleLabel(role: BoardExecutorRole): string {
  return ROLE_LABELS[role];
}

/**
 * The most specific sentence available for a failed board RPC. `BoardError`
 * carries its reason in `detail` and leaves `message` empty, so message-first is
 * not enough.
 */
export function boardFailureText(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.trim().length > 0
  ) {
    return error.detail;
  }
  return "The board server rejected the request.";
}

export interface BoardFilters {
  readonly showArchived: boolean;
  readonly role: BoardExecutorRole | null;
  readonly search: string;
}

export const DEFAULT_BOARD_FILTERS: BoardFilters = {
  showArchived: false,
  role: null,
  search: "",
};

/** Archived cards stay hidden unless asked for; role and text narrow the rest. */
export function filterBoardCards(
  cards: ReadonlyArray<BoardCard>,
  filters: BoardFilters,
): ReadonlyArray<BoardCard> {
  const query = filters.search.trim().toLowerCase();
  return cards.filter((card) => {
    if (!filters.showArchived && card.archived) return false;
    if (filters.role !== null && card.executorRole !== filters.role) return false;
    if (query.length === 0) return true;
    return card.title.toLowerCase().includes(query) || card.body.toLowerCase().includes(query);
  });
}

/** Case-insensitive title search for the orchestrator chat picker. */
export function filterChatCandidates<T extends { readonly title: string }>(
  chats: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return chats;
  return chats.filter((chat) => chat.title.toLowerCase().includes(needle));
}

/** Column order is fixed by the design; within a column `order` wins, then recency. */
export function sortBoardCards(cards: ReadonlyArray<BoardCard>): ReadonlyArray<BoardCard> {
  return [...cards].toSorted((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
  });
}

export function groupBoardCardsByStatus(
  cards: ReadonlyArray<BoardCard>,
): ReadonlyMap<BoardCardStatus, ReadonlyArray<BoardCard>> {
  const grouped = new Map<BoardCardStatus, BoardCard[]>(
    BOARD_COLUMNS.map(({ status }) => [status, []] as const),
  );
  for (const card of sortBoardCards(cards)) {
    grouped.get(card.status)?.push(card);
  }
  return grouped;
}

/**
 * Human card mutations (executor, status, delete) stop at `todo`: after Start
 * the card is orchestrator-owned and read-only for the human (design §5).
 */
export function isCardHumanEditable(card: BoardCard): boolean {
  return card.status === "todo";
}

export function isCardStartable(card: BoardCard): boolean {
  return card.status === "todo" && !card.archived;
}

/** Progress entries from a `board.list` payload, or none before the first read. */
export function boardListEvents(result: BoardListResult | null): ReadonlyArray<BoardCardEvent> {
  return result?.events ?? [];
}

/** Progress entries for one card, oldest first. */
export function boardEventsForCard(
  events: ReadonlyArray<BoardCardEvent>,
  cardId: BoardCard["cardId"],
): ReadonlyArray<BoardCardEvent> {
  return events
    .filter((event) => event.cardId === cardId)
    .toSorted((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
}

export function formatBoardEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
