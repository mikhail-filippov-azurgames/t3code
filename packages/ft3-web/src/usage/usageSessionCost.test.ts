import { describe, expect, it } from "vite-plus/test";

import { formatUsdPerSession } from "./usageSessionCost";

describe("formatUsdPerSession", () => {
  it("averages known cost over sessions", () => {
    expect(formatUsdPerSession(10, 4)).toBe("$2.50");
    expect(formatUsdPerSession(6, 2)).toBe("$3.00");
  });

  it("reports unknown cost instead of a misleading zero", () => {
    expect(formatUsdPerSession(0, 4)).toBe("—");
    expect(formatUsdPerSession(-1, 4)).toBe("—");
  });

  it("reports unknown averages without sessions or with bad input", () => {
    expect(formatUsdPerSession(10, 0)).toBe("—");
    expect(formatUsdPerSession(Number.NaN, 4)).toBe("—");
    expect(formatUsdPerSession(10, Number.POSITIVE_INFINITY)).toBe("—");
  });
});
