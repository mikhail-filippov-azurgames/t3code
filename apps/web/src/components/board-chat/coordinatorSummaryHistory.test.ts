import {
  EnvironmentId,
  ThreadId,
  TurnId,
  type OrchestrationDelegatedTaskSummaryHistoryRecord,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Cause } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SUMMARY_HISTORY_PAGE_SIZE,
  createCoordinatorSummaryHistoryLoader,
} from "./coordinatorSummaryHistory";

const environmentId = EnvironmentId.make("environment-local");
const parentThreadId = ThreadId.make("coordinator");
const completedAt = "2026-10-06T00:00:00.000Z";

function record(
  overrides: Partial<OrchestrationDelegatedTaskSummaryHistoryRecord> = {},
): OrchestrationDelegatedTaskSummaryHistoryRecord {
  return {
    childThreadId: ThreadId.make("child-1"),
    sourceTurnId: TurnId.make("turn-1"),
    completedAt,
    summaryText: "Готово: исправлен запуск",
    summaryState: "ready",
    summaryWatermark: 4,
    currentTurnId: TurnId.make("turn-1"),
    currentTurnState: "completed",
    currentWatermark: 4,
    executorRole: "implementation",
    stale: false,
    ...overrides,
  };
}

describe("createCoordinatorSummaryHistoryLoader", () => {
  it("requests the parent lineage page by cursor and maps records to rows", async () => {
    const cursor = {
      completedAt,
      childThreadId: ThreadId.make("child-0"),
      sourceTurnId: TurnId.make("turn-0"),
    };
    const nextCursor = {
      completedAt,
      childThreadId: ThreadId.make("child-2"),
      sourceTurnId: TurnId.make("turn-2"),
    };
    const query = vi.fn(async () =>
      AsyncResult.success({
        records: [
          record(),
          record({
            childThreadId: ThreadId.make("child-2"),
            sourceTurnId: TurnId.make("turn-2"),
            summaryState: "pending",
            summaryText: "",
            currentTurnId: TurnId.make("turn-3"),
            currentTurnState: "running",
            stale: true,
          }),
        ],
        nextCursor,
      }),
    );
    const load = createCoordinatorSummaryHistoryLoader({
      environmentId,
      query,
      childLabel: (childThreadId) => (childThreadId === "child-1" ? "Починить запуск" : undefined),
    });

    const page = await load({ threadId: parentThreadId, cursor });

    expect(query).toHaveBeenCalledWith({
      environmentId,
      input: { parentThreadId, cursor, limit: SUMMARY_HISTORY_PAGE_SIZE },
    });
    expect(page.nextCursor).toEqual(nextCursor);
    expect(page.entries).toEqual([
      {
        id: "child-1:turn-1",
        summaryText: "Готово: исправлен запуск",
        child: "Починить запуск",
        turn: "turn-1",
        completedAt,
        currentStatus: "завершено",
        summaryStatus: "готова",
        executorRole: "implementation",
        stale: false,
      },
      {
        id: "child-2:turn-2",
        summaryText: "Выжимка ещё формируется.",
        child: "child-2",
        turn: "turn-2",
        completedAt,
        currentStatus: "выполняется",
        summaryStatus: "формируется",
        executorRole: "implementation",
        stale: true,
      },
    ]);
  });

  it("omits the cursor for the first page", async () => {
    const query = vi.fn(async () => AsyncResult.success({ records: [], nextCursor: null }));
    const load = createCoordinatorSummaryHistoryLoader({
      environmentId,
      query,
      childLabel: () => undefined,
    });

    await expect(load({ threadId: parentThreadId })).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
    expect(query).toHaveBeenCalledWith({
      environmentId,
      input: { parentThreadId, limit: SUMMARY_HISTORY_PAGE_SIZE },
    });
  });

  it("rejects when the request fails so the caller can show the failure", async () => {
    const cause = Cause.fail("rpc unavailable");
    const load = createCoordinatorSummaryHistoryLoader({
      environmentId,
      query: async () => AsyncResult.failure(cause),
      childLabel: () => undefined,
    });

    await expect(load({ threadId: parentThreadId })).rejects.toBe(cause);
  });
});
