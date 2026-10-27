import { FT3_BOARD_WS_METHODS } from "@t3tools/ft3-board/rpc-contracts";
import type { EnvironmentRpcSuccess } from "@t3tools/client-runtime/rpc";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

export const SUMMARY_HISTORY_PAGE_SIZE = 30;

type SummaryHistoryPage = EnvironmentRpcSuccess<
  (typeof FT3_BOARD_WS_METHODS)["boardDelegatedTaskSummaryHistory"]
>;
type SummaryHistoryRecord = SummaryHistoryPage["records"][number];
export type CoordinatorSummaryHistoryCursor = NonNullable<SummaryHistoryPage["nextCursor"]>;

export interface CoordinatorSummaryHistoryEntry {
  readonly id: string;
  readonly summaryText: string;
  readonly child: string;
  readonly turn: string;
  readonly completedAt: string;
  readonly currentStatus: string;
  readonly summaryStatus: string;
  readonly executorRole: string;
  readonly stale: boolean;
}

export interface CoordinatorSummaryHistoryPage {
  readonly entries: ReadonlyArray<CoordinatorSummaryHistoryEntry>;
  readonly nextCursor: SummaryHistoryPage["nextCursor"];
}

export type CoordinatorSummaryHistoryLoader = (input: {
  readonly threadId: ThreadId;
  readonly cursor?: CoordinatorSummaryHistoryCursor;
}) => Promise<CoordinatorSummaryHistoryPage>;

const CURRENT_STATUS_LABELS = {
  pending: "ожидает",
  running: "выполняется",
  interrupted: "прервано",
  completed: "завершено",
  error: "ошибка",
} as const;

const SUMMARY_STATUS_LABELS = {
  pending: "формируется",
  ready: "готова",
  error: "ошибка",
} as const;

function summaryTextFor(record: SummaryHistoryRecord): string {
  if (record.summaryText.length > 0) return record.summaryText;
  return record.summaryState === "error"
    ? "Не удалось составить выжимку."
    : "Выжимка ещё формируется.";
}

export function toCoordinatorSummaryHistoryEntry(
  record: SummaryHistoryRecord,
  childLabel: string | undefined,
): CoordinatorSummaryHistoryEntry {
  return {
    id: `${record.childThreadId}:${record.sourceTurnId}`,
    summaryText: summaryTextFor(record),
    child: childLabel ?? String(record.childThreadId),
    turn: String(record.sourceTurnId),
    completedAt: record.completedAt,
    currentStatus:
      record.currentTurnState === null
        ? "неизвестно"
        : CURRENT_STATUS_LABELS[record.currentTurnState],
    summaryStatus: SUMMARY_STATUS_LABELS[record.summaryState],
    executorRole: record.executorRole,
    stale: record.stale,
  };
}

type HistoryQuery = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly parentThreadId: ThreadId;
    readonly cursor?: CoordinatorSummaryHistoryCursor;
    readonly limit: number;
  };
}) => Promise<AtomCommandResult<SummaryHistoryPage, unknown>>;

/** Fetches one page per call; a failed request rejects and leaves paging state to the caller. */
export function createCoordinatorSummaryHistoryLoader(deps: {
  readonly environmentId: EnvironmentId;
  readonly query: HistoryQuery;
  readonly childLabel: (childThreadId: ThreadId) => string | undefined;
}): CoordinatorSummaryHistoryLoader {
  return async ({ threadId, cursor }) => {
    const result = await deps.query({
      environmentId: deps.environmentId,
      input: {
        parentThreadId: threadId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: SUMMARY_HISTORY_PAGE_SIZE,
      },
    });
    if (!AsyncResult.isSuccess(result)) throw result.cause;
    const page = result.value;
    return {
      entries: page.records.map((record) =>
        toCoordinatorSummaryHistoryEntry(record, deps.childLabel(record.childThreadId)),
      ),
      nextCursor: page.nextCursor,
    };
  };
}
