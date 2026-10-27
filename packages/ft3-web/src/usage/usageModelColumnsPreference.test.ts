import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_MODEL_COLUMNS } from "./usageModelColumns";
import { readUsageModelColumns, saveUsageModelColumns } from "./usageModelColumnsPreference";

const key = "t3code:ft3-usage-model-columns:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

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

describe("Usage model columns preference", () => {
  it("uses defaults when no preference has been saved", () => {
    expect(readUsageModelColumns()).toEqual(DEFAULT_MODEL_COLUMNS);
  });

  it("round-trips a custom column selection", () => {
    saveUsageModelColumns(["tokens", "sessions"]);
    expect(readUsageModelColumns()).toEqual(["tokens", "sessions"]);
  });

  it("uses defaults for an invalid payload and recovers on the next save", () => {
    values.set(key, '["bogus"]');
    expect(readUsageModelColumns()).toEqual(DEFAULT_MODEL_COLUMNS);
    saveUsageModelColumns(["cost"]);
    expect(readUsageModelColumns()).toEqual(["cost"]);
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsageModelColumns(["cost"]);
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveUsageModelColumns(["tokens"])).not.toThrow();
    expect(readUsageModelColumns()).toEqual(["cost"]);
    write.mockRestore();
    saveUsageModelColumns(["sessions"]);
    expect(readUsageModelColumns()).toEqual(["sessions"]);
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsageModelColumns()).toEqual(DEFAULT_MODEL_COLUMNS);
    expect(() => saveUsageModelColumns(["tokens"])).not.toThrow();
  });
});
