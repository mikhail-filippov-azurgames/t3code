import type {
  EnvironmentId,
  OrchestrationDelegatedTaskSummaryHistoryCursor,
  OrchestrationDelegatedTaskSummaryHistoryPage,
  OrchestrationDelegatedTaskSummaryHistoryRecord,
  ThreadId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

export const SUMMARY_HISTORY_PAGE_SIZE = 30;

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
  readonly nextCursor: OrchestrationDelegatedTaskSummaryHistoryCursor | null;
}

export type CoordinatorSummaryHistoryLoader = (input: {
  readonly threadId: ThreadId;
  readonly cursor?: OrchestrationDelegatedTaskSummaryHistoryCursor;
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

function summaryTextFor(record: OrchestrationDelegatedTaskSummaryHistoryRecord): string {
  if (record.summaryText.length > 0) return record.summaryText;
  return record.summaryState === "error"
    ? "Не удалось составить выжимку."
    : "Выжимка ещё формируется.";
}

export function toCoordinatorSummaryHistoryEntry(
  record: OrchestrationDelegatedTaskSummaryHistoryRecord,
  childLabel: string | undefined,
): CoordinatorSummaryHistoryEntry {
  return {
    id: `${record.childThreadId}:${record.sourceTurnId}`,
    summaryText: summaryTextFor(record),
    child: childLabel ?? record.childThreadId,
    turn: record.sourceTurnId,
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
    readonly cursor?: OrchestrationDelegatedTaskSummaryHistoryCursor;
    readonly limit: number;
  };
}) => Promise<AtomCommandResult<OrchestrationDelegatedTaskSummaryHistoryPage, unknown>>;

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
