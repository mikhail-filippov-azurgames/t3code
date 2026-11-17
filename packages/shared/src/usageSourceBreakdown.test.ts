import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  ProviderInstanceId,
  type UsageBucket,
  type UsageDay,
  type UsageModelFilter,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type EnvironmentUsage, mergeUsage } from "./usageMerge.ts";
import { usageSourceBreakdown } from "./usageSourceBreakdown.ts";

interface SourceInput {
  readonly provider?: UsageProviderKind;
  readonly hostId?: string;
  readonly homePath: string;
  readonly status?: UsageSource["status"];
  readonly distinctSessions?: number;
  readonly instances?: readonly { readonly id: string; readonly name?: string }[];
}

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly SourceInput[],
  options: { readonly readAt?: string; readonly modelFilter?: UsageModelFilter } = {},
): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: options.readAt ?? "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId ?? "host-a",
        provider: source.provider ?? "claude",
        resolvedHomePath: source.homePath,
        volumeId: `vol-${source.hostId ?? "host-a"}`,
      },
      status: source.status ?? "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
      ...(source.instances === undefined
        ? {}
        : {
            instances: source.instances.map(({ id, name }) => ({
              instanceId: ProviderInstanceId.make(id),
              ...(name === undefined ? {} : { displayName: name }),
            })),
          }),
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
    ...(options.modelFilter === undefined ? {} : { modelFilter: options.modelFilter }),
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

function breakdown(environments: readonly EnvironmentUsage[]) {
  const result = usageSourceBreakdown(environments, USAGE_CONTRACT_VERSION);
  const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
  // Rows plus the shared remainder must reproduce mergeUsage's provider totals.
  for (const [provider, entry] of result) {
    const total = merged.providers.find((item) => item.provider === provider);
    const parts = [...entry.rows, entry.unattributed];
    const sum = (pick: (part: (typeof parts)[number]) => number) =>
      parts.reduce((acc, part) => acc + pick(part), 0);
    expect(sum((part) => part.costUsd)).toBeCloseTo(total?.costUsd ?? 0);
    expect(sum((part) => part.totalTokens)).toBe(total?.totalTokens ?? 0);
    expect(sum((part) => part.records)).toBe(total?.records ?? 0);
    expect(sum((part) => part.sessions)).toBe(total?.sessions ?? 0);
  }
  return result;
}

const names = (row: { readonly instances: readonly { readonly instanceId: string }[] }) =>
  row.instances.map((instance) => instance.instanceId);

describe("usageSourceBreakdown", () => {
  it("shows a single labeled source as its own row", () => {
    const result = breakdown([
      environment(
        "local",
        summary(
          [bucket({ sourcePath: "/zavod" })],
          [{ homePath: "/zavod", instances: [{ id: "claudeZavod", name: "Zavod" }] }],
        ),
      ),
    ]);
    const claude = result.get("claude")!;
    expect(claude.rows).toHaveLength(1);
    expect(claude.rows[0]?.instances).toEqual([
      {
        environmentId: "local",
        environmentLabel: "local",
        instanceId: "claudeZavod",
        displayName: "Zavod",
      },
    ]);
    expect(claude.rows[0]?.costUsd).toBe(10);
    expect(claude.unattributed.costUsd).toBe(0);
  });

  it("keeps one sum and every name for a directory several instances share", () => {
    const result = breakdown([
      environment(
        "local",
        summary(
          [bucket({ sourcePath: "/shared" })],
          [
            {
              homePath: "/shared",
              instances: [{ id: "claudeAgent" }, { id: "claudeZavod", name: "Zavod" }],
            },
          ],
        ),
      ),
    ]);
    const rows = result.get("claude")!.rows;
    expect(rows).toHaveLength(1);
    expect(names(rows[0]!)).toEqual(["claudeAgent", "claudeZavod"]);
  });

  it("splits separate directories into separate rows", () => {
    const result = breakdown([
      environment(
        "local",
        summary(
          [
            bucket({ sourcePath: "/personal", costUsd: 3 }),
            bucket({ sourcePath: "/zavod", costUsd: 8 }),
          ],
          [
            { homePath: "/personal", instances: [{ id: "claudeAgent" }], distinctSessions: 2 },
            {
              homePath: "/zavod",
              instances: [{ id: "claudeZavod", name: "Zavod" }],
              distinctSessions: 4,
            },
          ],
        ),
      ),
    ]);
    const rows = result.get("claude")!.rows;
    expect(rows.map((row) => [names(row), row.costUsd, row.sessions])).toEqual([
      [["claudeZavod"], 8, 4],
      [["claudeAgent"], 3, 2],
    ]);
  });

  it("keeps an equal instanceId in two environments apart", () => {
    const result = breakdown([
      environment(
        "laptop",
        summary(
          [bucket({ sourcePath: "/zavod", costUsd: 2 })],
          [{ hostId: "laptop", homePath: "/zavod", instances: [{ id: "claudeZavod" }] }],
        ),
      ),
      environment(
        "server",
        summary(
          [bucket({ sourcePath: "/zavod", costUsd: 5 })],
          [{ hostId: "server", homePath: "/zavod", instances: [{ id: "claudeZavod" }] }],
        ),
      ),
    ]);
    const rows = result.get("claude")!.rows;
    expect(rows.map((row) => [row.instances[0]?.environmentId, row.costUsd])).toEqual([
      ["server", 5],
      ["laptop", 2],
    ]);
  });

  it("counts a fingerprint two environments read once, with both environments' names", () => {
    const shared = { hostId: "host-a", homePath: "/zavod" };
    const result = breakdown([
      environment(
        "desktop",
        summary(
          [bucket({ sourcePath: "/zavod" })],
          [{ ...shared, instances: [{ id: "claudeZavod" }] }],
        ),
      ),
      environment(
        "remote",
        summary([bucket({ sourcePath: "/zavod" })], [{ ...shared, instances: [{ id: "zavod" }] }]),
      ),
    ]);
    const rows = result.get("claude")!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBe(10);
    expect(rows[0]?.instances.map((instance) => instance.environmentId).toSorted()).toEqual([
      "desktop",
      "remote",
    ]);
  });

  it("adds a newer partial scan's missing cells to the labeled row", () => {
    const source = { homePath: "/zavod", instances: [{ id: "claudeZavod" }] };
    const result = breakdown([
      environment(
        "complete",
        summary([bucket({ sourcePath: "/zavod" })], [source], {
          readAt: "2026-08-07T00:00:00.000Z",
        }),
      ),
      environment(
        "partial",
        summary(
          [
            bucket({ sourcePath: "/zavod" }),
            bucket({ sourcePath: "/zavod", day: "2026-08-08" as UsageDay, costUsd: 4 }),
          ],
          [{ ...source, status: "partial", distinctSessions: 3 }],
          { readAt: "2026-08-08T00:00:00.000Z" },
        ),
      ),
    ]);
    const row = result.get("claude")!.rows[0]!;
    expect(row.costUsd).toBe(14);
    expect(row.sessions).toBe(3);
  });

  it("ignores a partial scan under another model filter", () => {
    const source = { homePath: "/zavod", instances: [{ id: "claudeZavod" }] };
    const result = breakdown([
      environment("complete", summary([bucket({ sourcePath: "/zavod" })], [source])),
      environment(
        "partial",
        summary(
          [bucket({ sourcePath: "/zavod", day: "2026-08-08" as UsageDay, costUsd: 4 })],
          [{ ...source, status: "partial" }],
          {
            readAt: "2026-08-08T00:00:00.000Z",
            modelFilter: { include: [{ model: "claude-fable-5" }] },
          },
        ),
      ),
    ]);
    expect(result.get("claude")!.rows[0]?.costUsd).toBe(10);
  });

  it("leaves an older response without instances to the provider total", () => {
    const result = breakdown([
      environment(
        "old",
        summary(
          [bucket({ sourcePath: "/a" }), bucket({ sourcePath: "/b" })],
          [{ homePath: "/a" }, { homePath: "/b" }],
        ),
      ),
    ]);
    const claude = result.get("claude")!;
    expect(claude.rows).toEqual([]);
    expect(claude.unattributed.costUsd).toBe(20);
  });

  it("puts a legacy bucket without sourcePath in the shared row when sources are ambiguous", () => {
    const result = breakdown([
      environment(
        "local",
        summary(
          [bucket({ sourcePath: "/zavod", costUsd: 6 }), bucket({ costUsd: 1 })],
          [{ homePath: "/zavod", instances: [{ id: "claudeZavod" }] }, { homePath: "/other" }],
        ),
      ),
    ]);
    const claude = result.get("claude")!;
    expect(claude.rows[0]?.costUsd).toBe(6);
    expect(claude.unattributed.costUsd).toBe(1);
  });

  it("credits a legacy bucket to the provider's only source", () => {
    const result = breakdown([
      environment(
        "local",
        summary([bucket()], [{ homePath: "/zavod", instances: [{ id: "claudeZavod" }] }]),
      ),
    ]);
    expect(result.get("claude")!.rows[0]?.costUsd).toBe(10);
  });

  it("follows the selected window and model filter of the summaries it receives", () => {
    const source = { homePath: "/zavod", instances: [{ id: "claudeZavod" }] };
    const wide = breakdown([
      environment(
        "local",
        summary(
          [
            bucket({ sourcePath: "/zavod" }),
            bucket({ sourcePath: "/zavod", model: "other", costUsd: 5 }),
          ],
          [source],
        ),
      ),
    ]);
    const narrow = breakdown([
      environment(
        "local",
        summary([bucket({ sourcePath: "/zavod" })], [source], {
          modelFilter: { include: [{ model: "claude-fable-5" }] },
        }),
      ),
    ]);
    expect(wide.get("claude")!.rows[0]?.costUsd).toBe(15);
    expect(narrow.get("claude")!.rows[0]?.costUsd).toBe(10);
  });

  it("shows a labeled source without usage as an empty row", () => {
    const result = breakdown([
      environment(
        "local",
        summary(
          [bucket({ sourcePath: "/personal" })],
          [
            { homePath: "/personal", instances: [{ id: "claudeAgent" }] },
            { homePath: "/zavod", status: "missing", instances: [{ id: "claudeZavod" }] },
          ],
        ),
      ),
    ]);
    const rows = result.get("claude")!.rows;
    expect(rows.map((row) => [names(row), row.costUsd])).toEqual([
      [["claudeAgent"], 10],
      [["claudeZavod"], 0],
    ]);
  });
});
