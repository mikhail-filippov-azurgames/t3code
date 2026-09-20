import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_MODEL_COLUMNS, type ModelColumnId } from "./usageModelColumns";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

const defaultPreferences: UsagePagePreferences = {
  metric: "limits",
  windowDays: 30,
  modelColumns: [...DEFAULT_MODEL_COLUMNS],
};

const preferences = (
  overrides: Partial<UsagePagePreferences> & Pick<UsagePagePreferences, "metric" | "windowDays">,
): UsagePagePreferences => ({
  modelColumns: [...DEFAULT_MODEL_COLUMNS],
  ...overrides,
});

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("uses defaults when no preference has been saved", () => {
    expect(readUsagePagePreferences()).toEqual(defaultPreferences);
  });

  it.each([1, 7, 30, 90] as const)("round-trips every metric with a %i-day range", (windowDays) => {
    for (const metric of ["cost", "tokens", "limits"] as const) {
      saveUsagePagePreferences(preferences({ metric, windowDays }));
      expect(readUsagePagePreferences()).toEqual(preferences({ metric, windowDays }));
    }
  });

  it("round-trips a custom model-column selection", () => {
    const custom: ModelColumnId[] = ["tokens", "sessions"];
    saveUsagePagePreferences(preferences({ metric: "cost", windowDays: 7, modelColumns: custom }));
    expect(readUsagePagePreferences()).toEqual(
      preferences({ metric: "cost", windowDays: 7, modelColumns: custom }),
    );
  });

  it("fills in default columns for payloads saved before the column picker", () => {
    values.set(key, '{"metric":"cost","windowDays":7}');
    expect(readUsagePagePreferences()).toEqual(
      preferences({ metric: "cost", windowDays: 7, modelColumns: [...DEFAULT_MODEL_COLUMNS] }),
    );
  });

  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
    '{"metric":"cost","windowDays":7,"modelColumns":["bogus"]}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual(defaultPreferences);
    saveUsagePagePreferences(preferences({ metric: "tokens", windowDays: 7 }));
    expect(readUsagePagePreferences()).toEqual(preferences({ metric: "tokens", windowDays: 7 }));
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsagePagePreferences(preferences({ metric: "cost", windowDays: 30 }));
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      saveUsagePagePreferences(preferences({ metric: "tokens", windowDays: 7 })),
    ).not.toThrow();
    expect(readUsagePagePreferences()).toEqual(preferences({ metric: "cost", windowDays: 30 }));
    write.mockRestore();
    saveUsagePagePreferences(preferences({ metric: "limits", windowDays: 7 }));
    expect(readUsagePagePreferences()).toEqual(preferences({ metric: "limits", windowDays: 7 }));
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsagePagePreferences()).toEqual(defaultPreferences);
    expect(() =>
      saveUsagePagePreferences(preferences({ metric: "tokens", windowDays: 7 })),
    ).not.toThrow();
  });
});
