import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_MODEL_COLUMNS, isModelColumnId } from "./usageModelColumns";

describe("isModelColumnId", () => {
  it("accepts every default column id", () => {
    for (const id of DEFAULT_MODEL_COLUMNS) {
      expect(isModelColumnId(id)).toBe(true);
    }
  });

  it("rejects unknown ids", () => {
    expect(isModelColumnId("bogus")).toBe(false);
    expect(isModelColumnId("")).toBe(false);
  });
});
