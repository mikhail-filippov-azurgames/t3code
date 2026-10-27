import type { ModelTotals } from "@t3tools/shared/usageMerge";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Toggle: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("~/components/chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => <span />,
}));

import { render } from "../../../../apps/web/test/render";
import { UsageModelTable } from "./UsageModelTable.tsx";

function model(overrides: Partial<ModelTotals> & Pick<ModelTotals, "model">): ModelTotals {
  return {
    provider: "codex",
    costUsd: 0,
    totalTokens: 0,
    tokens: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    records: 1,
    unpricedRecords: 0,
    unpricedTokens: 0,
    sessions: 0,
    costShare: 0,
    tokenShare: 0,
    ...overrides,
  };
}

const models = [
  model({
    model: "expensive-model",
    provider: "claude",
    costUsd: 10,
    totalTokens: 100,
    sessions: 4,
  }),
  model({ model: "token-heavy-model", costUsd: 5, totalTokens: 1_000, sessions: 42 }),
  model({ model: "token-heavy-cheaper-model", costUsd: 1, totalTokens: 1_000, sessions: 2 }),
  model({
    model: "unpriced-model",
    costUsd: 0,
    totalTokens: 500,
    records: 2,
    unpricedRecords: 2,
    sessions: 1,
  }),
  model({ model: "zero-token-model", costUsd: 1, totalTokens: 0, sessions: 1 }),
];

beforeEach(() => {
  localStorage.clear();
});

async function renderTable(metric: "cost" | "tokens") {
  return render(
    <UsageModelTable
      models={models}
      metric={metric}
      loadingProviders={new Set()}
      onSelectModel={() => {}}
    />,
    { router: false },
  );
}

describe("UsageModelTable", () => {
  it("shows our own columns and toggles by metric", async () => {
    await using screen = await renderTable("cost");
    const text = screen.container.textContent ?? "";
    expect(text).toContain("$/1M tokens");
    expect(text).toContain("Sessions");
    expect(text).toContain("Cost");
    expect(text).toContain("$100,000.00");
  });

  it("shows per-model session counts", async () => {
    await using screen = await renderTable("cost");
    const body = screen.container.querySelector("tbody")?.textContent ?? "";
    const tokenHeavy = Array.from(screen.container.querySelectorAll("tbody tr")).find((row) =>
      row.textContent?.includes("token-heavy-model"),
    );
    expect(tokenHeavy?.textContent).toContain("42");
    expect(body).toContain("expensive-model");
  });

  it("sorts by cost for the cost metric", async () => {
    await using screen = await renderTable("cost");
    const body = screen.container.querySelector("tbody")?.textContent ?? "";
    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("sorts from the cost fallback when costs tie under the token metric", async () => {
    await using screen = await renderTable("tokens");
    const body = screen.container.querySelector("tbody")?.textContent ?? "";
    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
  });

  it("flags unpriced rows and never prices a zero-token model", async () => {
    await using screen = await renderTable("cost");
    const rows = Array.from(screen.container.querySelectorAll("tbody tr"));
    const unpricedRow = rows.find((row) => row.textContent?.includes("unpriced-model"));
    const zeroTokenRow = rows.find((row) => row.textContent?.includes("zero-token-model"));
    expect(unpricedRow?.textContent).toContain("Unpriced");
    expect(unpricedRow?.textContent).not.toContain("$0.00");
    expect(zeroTokenRow?.textContent).toContain("—");
    expect(zeroTokenRow?.textContent).not.toContain("Infinity");
    expect(zeroTokenRow?.textContent).not.toContain("NaN");
  });
});
