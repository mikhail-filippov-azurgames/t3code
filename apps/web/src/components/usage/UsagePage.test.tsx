import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  metric: "cost" as "cost" | "tokens" | "limits",
  breakdown: "time" as "model" | "time",
}));

const OPEN_CODE_PROVIDER = "opencode" as const;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      initial === readUsagePagePreferences
        ? { metric: testState.metric, windowDays: 30, modelColumns: [...DEFAULT_MODEL_COLUMNS] }
        : typeof initial === "function"
          ? {
              days: 1,
              window: {
                sinceDay: "2026-08-10",
                untilDay: "2026-08-11",
                timeZone: "UTC",
                resolution: "hour",
                sinceTime: "2026-08-10T12:37:00.000Z",
                untilTime: "2026-08-11T12:37:00.000Z",
              },
            }
          : initial === "cost"
            ? testState.metric
            : initial === "model"
              ? testState.breakdown
              : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
      opencode: { color: "violet", label: "OpenCode", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";
import { DEFAULT_MODEL_COLUMNS } from "./usageModelColumns";
import { readUsagePagePreferences } from "./usagePagePreferences";

const providerTotals = (codex: number, claude: number, opencode = 0) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
    [OPEN_CODE_PROVIDER, { costUsd: opencode, totalTokens: opencode * 1_000 }],
  ] as const);

const modelTotals = Object.freeze([
  {
    model: "expensive-model",
    provider: "claude" as const,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    unpricedRecords: 0,
    sessions: 4,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    unpricedRecords: 0,
    sessions: 42,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    unpricedRecords: 0,
    sessions: 2,
    costShare: 1 / 16,
  },
  {
    model: "unpriced-model",
    provider: "codex" as const,
    costUsd: 0,
    totalTokens: 500,
    records: 2,
    unpricedRecords: 2,
    sessions: 1,
    costShare: 0,
  },
]);

const openCodeModel = {
  model: "opencode/gpt-5.6-luna",
  provider: OPEN_CODE_PROVIDER,
  costUsd: 3,
  totalTokens: 300,
  records: 1,
  unpricedRecords: 0,
  sessions: 3,
  costShare: 1,
};

const zeroTokenModel = {
  model: "zero-token-model",
  provider: "codex" as const,
  costUsd: 1,
  totalTokens: 0,
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
  costShare: 1,
};

const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.metric = "cost";
  testState.breakdown = "time";
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
        },
      ],
    },
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

function usageResultWithOpenCode() {
  return {
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      providers: [
        {
          provider: OPEN_CODE_PROVIDER,
          costUsd: openCodeModel.costUsd,
          totalTokens: openCodeModel.totalTokens,
          records: openCodeModel.records,
          sessions: 1,
          costShare: 1,
          tokenShare: 1,
        },
      ],
      models: [openCodeModel],
      hourly: [
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: openCodeModel.costUsd,
          totalTokens: openCodeModel.totalTokens,
          byProvider: providerTotals(0, 0, openCodeModel.costUsd),
        },
      ],
    },
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  };
}

function usageResultWithModels(models: readonly (typeof modelTotals)[number][]) {
  return {
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models,
      hourly: [],
      daily: [],
    },
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  };
}

describe("UsagePage hourly breakdown", () => {
  it("keeps recent activity visible first without empty hourly rows", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body).toContain("$11.00");
    expect(body).toContain("$13.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });

  it("keeps chronological ordering when the token metric is selected", () => {
    testState.metric = "tokens";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/\$11\.00.*\$13\.00/);
  });
});

describe("UsagePage average cost per session", () => {
  beforeEach(() => {
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        costUsd: 10,
        sessions: 4,
        providers: [
          {
            provider: "codex",
            costUsd: 6,
            totalTokens: 600,
            records: 2,
            sessions: 2,
            costShare: 0.6,
            tokenShare: 0.6,
          },
          {
            provider: "claude",
            costUsd: 4,
            totalTokens: 400,
            records: 2,
            sessions: 2,
            costShare: 0.4,
            tokenShare: 0.4,
          },
        ],
      },
      environments,
      selectedEnvironments: environments,
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });
  });

  it("shows the window average and each provider's average", () => {
    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("Avg cost / session");
    expect(markup).toContain("$2.50");
    expect(markup).toContain("$3.00/session");
    expect(markup).toContain("$2.00/session");
  });

  it("renders an unknown average instead of a misleading zero", () => {
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        providers: [
          {
            provider: "codex",
            costUsd: 0,
            totalTokens: 600,
            records: 2,
            sessions: 2,
            costShare: 0,
            tokenShare: 1,
          },
        ],
      },
      environments,
      selectedEnvironments: environments,
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);
    const totalsTile = markup.split("Avg cost / session")[1] ?? "";

    expect(totalsTile).toContain("—");
    expect(totalsTile).not.toContain("$0.00");
  });
});

describe("UsagePage model breakdown", () => {
  it("renders an OpenCode provider total and model row", () => {
    testState.breakdown = "model";
    testState.useUsage.mockReturnValue(usageResultWithOpenCode());

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(markup).toContain("OpenCode");
    expect(body).toContain("opencode/gpt-5.6-luna");
  });

  it("shows cost per million tokens for priced models", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(markup).toContain("$/1M tokens");
    expect(body).toContain("$100,000.00");
  });

  it("shows per-model session counts in a toggleable Sessions column", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    const tokenHeavyRow = body.split("<tr").find((row) => row.includes("token-heavy-model")) ?? "";

    expect(markup).toContain("Sessions");
    expect(markup).toContain('aria-label="Model columns"');
    expect(tokenHeavyRow).toContain(">42<");
  });

  it("sorts models by cost when the cost metric is selected", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("flags a model with no known rates instead of showing it as free", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    const unpricedRow = body.split("<tr").find((row) => row.includes("unpriced-model")) ?? "";

    expect(unpricedRow).toContain("Unpriced");
    expect(unpricedRow).not.toContain("$0.00");
  });

  it("does not produce a price for a zero-token model", () => {
    testState.breakdown = "model";
    testState.useUsage.mockReturnValue(usageResultWithModels([...modelTotals, zeroTokenModel]));

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    const zeroTokenRow = body.split("<tr").find((row) => row.includes("zero-token-model")) ?? "";

    expect(zeroTokenRow).toContain("—");
    expect(zeroTokenRow).not.toContain("Infinity");
    expect(zeroTokenRow).not.toContain("NaN");
  });

  it("sorts models by token usage when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
    expect(modelTotals.map((model) => model.model)).toEqual([
      "expensive-model",
      "token-heavy-model",
      "token-heavy-cheaper-model",
      "unpriced-model",
    ]);
  });
});
