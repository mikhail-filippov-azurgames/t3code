import { EnvironmentId, ProviderTurnId, ThreadId, TurnId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SUMMARY_HISTORY_PAGE_SIZE,
  coordinatorSummaryExecutorLabel,
  createCoordinatorSummaryHistoryLoader,
  toCoordinatorSummaryHistoryEntry,
} from "./coordinatorSummaryHistory";

const environmentId = EnvironmentId.make("environment-local");
const parentThreadId = ThreadId.make("coordinator");
const childThreadId = ThreadId.make("delegated-task:a8687f");

type HistoryRecord = Parameters<typeof toCoordinatorSummaryHistoryEntry>[0];

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    childThreadId,
    sourceTurnId: TurnId.make("turn:one"),
    completedAt: "2026-10-26T10:38:33.024Z",
    summaryText: "Outcome: audit recorded.",
    summaryState: "ready" as const,
    summaryWatermark: 4,
    currentTurnId: ProviderTurnId.make("turn:one"),
    currentTurnState: "completed" as const,
    currentWatermark: 4,
    childTitle: "Аудит новой графики Workshop",
    executorRole: "research",
    executorProviderInstanceId: "claudeAgent",
    executorModel: "claude-opus-4-1",
    stale: false,
    ...overrides,
  };
}

describe("toCoordinatorSummaryHistoryEntry", () => {
  it("uses the server child title and carries the executor", () => {
    expect(toCoordinatorSummaryHistoryEntry(record(), undefined)).toEqual({
      id: "delegated-task:a8687f:turn:one",
      summaryText: "Outcome: audit recorded.",
      child: "Аудит новой графики Workshop",
      turn: "turn:one",
      completedAt: "2026-10-26T10:38:33.024Z",
      currentStatus: "завершено",
      summaryStatus: "готова",
      executorRole: "research",
      executorProviderInstanceId: "claudeAgent",
      executorModel: "claude-opus-4-1",
      stale: false,
    });
  });

  it("falls back to the client shell title, then to the raw id", () => {
    expect(toCoordinatorSummaryHistoryEntry(record({ childTitle: null }), "Thread").child).toBe(
      "Thread",
    );
    expect(toCoordinatorSummaryHistoryEntry(record({ childTitle: null }), undefined).child).toBe(
      "delegated-task:a8687f",
    );
  });

  it("reports the real current state instead of unknown when the server has it", () => {
    expect(
      toCoordinatorSummaryHistoryEntry(record({ currentTurnState: "running" }), undefined)
        .currentStatus,
    ).toBe("выполняется");
    expect(
      toCoordinatorSummaryHistoryEntry(record({ currentTurnState: null }), undefined).currentStatus,
    ).toBe("неизвестно");
  });
});

describe("coordinatorSummaryExecutorLabel", () => {
  it("joins provider and model and drops the missing half", () => {
    expect(
      coordinatorSummaryExecutorLabel({
        executorProviderInstanceId: "claudeAgent",
        executorModel: "claude-opus-4-1",
      }),
    ).toBe("claudeAgent · claude-opus-4-1");
    expect(
      coordinatorSummaryExecutorLabel({
        executorProviderInstanceId: "claudeAgent",
        executorModel: null,
      }),
    ).toBe("claudeAgent");
    expect(
      coordinatorSummaryExecutorLabel({
        executorProviderInstanceId: null,
        executorModel: null,
      }),
    ).toBeNull();
  });
});

describe("createCoordinatorSummaryHistoryLoader", () => {
  it("requests the page and maps records through the server title", async () => {
    const query = vi.fn(async () => AsyncResult.success({ records: [record()], nextCursor: null }));
    const load = createCoordinatorSummaryHistoryLoader({
      environmentId,
      query,
      childLabel: () => "Client thread title",
    });

    const page = await load({ threadId: parentThreadId });

    expect(query).toHaveBeenCalledWith({
      environmentId,
      input: { parentThreadId, limit: SUMMARY_HISTORY_PAGE_SIZE },
    });
    expect(page.entries[0]!.child).toBe("Аудит новой графики Workshop");
    expect(page.nextCursor).toBeNull();
  });
});
