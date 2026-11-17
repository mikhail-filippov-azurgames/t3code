import {
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { usageSourceRows } from "@t3tools/shared/usageSourceBreakdown";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";

const summaries = vi.hoisted(() => new Map<string, unknown>());

vi.mock(import("~/state/presentation"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const presentation = {
    entry: { target: { label: "workstation" } },
    connection: { phase: "connected" },
  };
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: Atom.make(new Map([["workstation", presentation]])) as never,
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const actual = await original();
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: ["diagnostics:read"] }),
  );
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => session) as never,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const noFilter = Atom.make(undefined);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      usageModelFilterAtom: (() => noFilter) as never,
      usageSummary: ((target: { input: UsageSummaryInput }) =>
        summaries.get(target.input.sinceDay)) as never,
    },
  };
});

import { useUsage } from "./usage";

const windowFor = (sinceDay: string): UsageSummaryInput => ({
  sinceDay: sinceDay as UsageDay,
  untilDay: "2026-08-31" as UsageDay,
  timeZone: "UTC",
});

const summary = (sinceDay: string, costUsd: number): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-31T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: sinceDay as UsageDay,
  untilDay: "2026-08-31" as UsageDay,
  buckets: [
    {
      day: "2026-08-20" as UsageDay,
      provider: "claude",
      model: "claude-fable-5",
      sourcePath: "/zavod",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      costUsd,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: { hostId: "h", provider: "claude", resolvedHomePath: "/zavod", volumeId: "1" },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
      instances: [{ instanceId: ProviderInstanceId.make("claudeZavod"), displayName: "Zavod" }],
    },
  ],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
});

function Probe(props: { readonly input: UsageSummaryInput }) {
  const { shown } = useUsage(props.input);
  if (shown === null) return <p>pending</p>;
  const rows = usageSourceRows(shown.sources.get("claude"));
  return (
    <p>
      {`total ${shown.merged.costUsd}; rows ${rows.map((row) => `${row.label}=${row.costUsd}`).join(",")}`}
    </p>
  );
}

describe("useUsage source snapshot", () => {
  it("keeps the previous rows with the previous total until the new window answers", async () => {
    const first = Atom.make(AsyncResult.success(summary("2026-08-01", 3)));
    const second = Atom.make<AsyncResult.AsyncResult<UsageSummary>>(AsyncResult.initial(true));
    summaries.set("2026-08-01", first);
    summaries.set("2026-08-15", second);
    const ui = (input: UsageSummaryInput) => (
      <AppAtomRegistryProvider>
        <Probe input={input} />
      </AppAtomRegistryProvider>
    );
    const wide = windowFor("2026-08-01");
    await using screen = await render(ui(wide), { router: false });
    await expect.element(screen.getByText("total 3; rows Zavod=3")).toBeVisible();

    await screen.rerender(ui(windowFor("2026-08-15")));
    await expect.element(screen.getByText("total 3; rows Zavod=3")).toBeVisible();

    await act(() => appAtomRegistry.set(second, AsyncResult.success(summary("2026-08-15", 2))));
    await expect.element(screen.getByText("total 2; rows Zavod=2")).toBeVisible();
  });
});
