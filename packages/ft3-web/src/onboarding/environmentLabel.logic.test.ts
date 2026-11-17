import { describe, expect, it } from "vite-plus/test";

import { readableEnvironmentLabel } from "./environmentLabel.logic.ts";

const environmentId = "3f2b8c1e-5d4a-4b7e-9c2f-1a2b3c4d5e6f";

describe("readableEnvironmentLabel", () => {
  it("keeps a real label", () => {
    expect(
      readableEnvironmentLabel({ label: "Work laptop", environmentId, hostname: "WS-1" }),
    ).toBe("Work laptop");
  });

  it.each([environmentId, "", "  ", undefined])(
    "uses the host name instead of label %j",
    (label) => {
      expect(readableEnvironmentLabel({ label, environmentId, hostname: "WS-1" })).toBe("WS-1");
    },
  );

  it("falls back to this computer without a host name", () => {
    expect(readableEnvironmentLabel({ label: environmentId, environmentId, hostname: " " })).toBe(
      "this computer",
    );
  });
});
