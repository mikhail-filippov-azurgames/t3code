import type { ThreadId } from "@t3tools/contracts";
import {
  ExecutorRole,
  type BoardCard,
  type BoardCardEvent,
  type BoardCardReadiness,
  type BoardCardStatus,
  type BoardDelegationStatus,
  type BoardListResult,
  type ExecutorRole as BoardExecutorRole,
} from "@t3tools/ft3-board/contracts";
import * as Cause from "effect/Cause";

export const BOARD_COLUMNS: ReadonlyArray<{
  readonly status: BoardCardStatus;
  readonly label: string;
}> = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To do" },
  { status: "orchestrator", label: "Coordinator" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export const BOARD_EXECUTOR_ROLES: ReadonlyArray<BoardExecutorRole> = ExecutorRole.literals;

export type BoardReadinessFilter = "all" | Exclude<BoardCardReadiness, "ready">;

const STATUS_LABELS: Readonly<Record<BoardCardStatus, string>> = {
  backlog: "Backlog",
  todo: "To do",
  orchestrator: "Coordinator",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export function boardExecutorRoleLabel(role: BoardExecutorRole): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

const READINESS_LABELS: Readonly<Record<BoardCardReadiness, string>> = {
  ready: "Ready",
  needs_human: "Needs human",
  blocked: "Blocked",
};

export function boardStatusLabel(status: BoardCardStatus): string {
  return STATUS_LABELS[status];
}

export function boardReadinessLabel(readiness: BoardCardReadiness): string {
  return READINESS_LABELS[readiness];
}

export function shouldShowBoardReadiness(readiness: BoardCardReadiness): boolean {
  return readiness !== "ready";
}

export function countNeedsHumanCards(cards: ReadonlyArray<BoardCard>): number {
  return cards.filter((card) => !card.archived && card.readiness === "needs_human").length;
}

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
  readonly readiness: BoardReadinessFilter;
  readonly search: string;
}

export const DEFAULT_BOARD_FILTERS: BoardFilters = {
  showArchived: false,
  role: null,
  readiness: "all",
  search: "",
};

export function filterBoardCards(
  cards: ReadonlyArray<BoardCard>,
  filters: BoardFilters,
): ReadonlyArray<BoardCard> {
  const query = filters.search.trim().toLowerCase();
  return cards.filter((card) => {
    if (!filters.showArchived && card.archived) return false;
    if (filters.role !== null && card.executorRole !== filters.role) return false;
    if (filters.readiness !== "all" && card.readiness !== filters.readiness) return false;
    if (query.length === 0) return true;
    return card.title.toLowerCase().includes(query) || card.body.toLowerCase().includes(query);
  });
}

export function filterChatCandidates<T extends { readonly title: string }>(
  chats: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return chats;
  return chats.filter((chat) => chat.title.toLowerCase().includes(needle));
}

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

export type BoardStatusCounts = Readonly<Record<BoardCardStatus, number>>;

const ZERO_BOARD_STATUS_COUNTS: Record<BoardCardStatus, number> = {
  backlog: 0,
  todo: 0,
  orchestrator: 0,
  in_progress: 0,
  review: 0,
  done: 0,
};

export function countBoardCardsByStatus(cards: ReadonlyArray<BoardCard>): BoardStatusCounts {
  const counts: Record<BoardCardStatus, number> = { ...ZERO_BOARD_STATUS_COUNTS };
  for (const card of cards) {
    counts[card.status] += 1;
  }
  return counts;
}

export function countArchivedBoardCardsByStatus(
  cards: ReadonlyArray<BoardCard>,
): BoardStatusCounts {
  const counts: Record<BoardCardStatus, number> = { ...ZERO_BOARD_STATUS_COUNTS };
  for (const card of cards) {
    if (card.archived) counts[card.status] += 1;
  }
  return counts;
}

export function countOmittedArchivedByStatus(
  list: BoardListResult | null,
  orchestratorThreadId: ThreadId | null,
): BoardStatusCounts {
  const counts: Record<BoardCardStatus, number> = { ...ZERO_BOARD_STATUS_COUNTS };
  for (const entry of list?.archivedCounts ?? []) {
    if (orchestratorThreadId === null || entry.orchestratorThreadId === orchestratorThreadId) {
      counts[entry.status] += entry.count;
    }
  }
  return counts;
}

export function addBoardStatusCounts(
  left: BoardStatusCounts,
  right: BoardStatusCounts,
): BoardStatusCounts {
  const sum: Record<BoardCardStatus, number> = { ...ZERO_BOARD_STATUS_COUNTS };
  for (const { status } of BOARD_COLUMNS) sum[status] = left[status] + right[status];
  return sum;
}

export function sumBoardStatusCounts(counts: BoardStatusCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function isCardHumanEditable(card: BoardCard): boolean {
  return card.status === "todo";
}

export function isCardStartable(card: BoardCard): boolean {
  return (card.status === "todo" || card.status === "backlog") && !card.archived;
}

export function boardListEvents(result: BoardListResult | null): ReadonlyArray<BoardCardEvent> {
  return result?.events ?? [];
}

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

const DELEGATION_STATUS_LABELS: Readonly<Record<BoardDelegationStatus, string>> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function boardDelegationStatusLabel(status: BoardDelegationStatus): string {
  return DELEGATION_STATUS_LABELS[status];
}

export function boardDelegationSummaryText(summary: string | null): string | null {
  if (summary === null) return null;
  const text = summary.trim();
  return text.length === 0 ? null : text;
}
