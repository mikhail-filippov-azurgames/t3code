import { describe, expect, it } from "vite-plus/test";

import { providersForWindow } from "./usageProviders.ts";

describe("providersForWindow", () => {
  it("keeps an OpenCode source visible across a 90-day window with no events", () => {
    expect(providersForWindow([], ["opencode"])).toEqual(["opencode"]);
  });

  it("keeps every provider with usage and every reporting source in a 24-hour window", () => {
    expect(
      providersForWindow(
        [
          { provider: "claude", costUsd: 2, totalTokens: 200 },
          { provider: "opencode", costUsd: 0, totalTokens: 50 },
        ],
        ["codex", "claude", "opencode"],
      ),
    ).toEqual(["codex", "claude", "opencode"]);
  });

  it("drops providers that neither report nor use tokens", () => {
    expect(providersForWindow([{ provider: "claude", costUsd: 0, totalTokens: 0 }], [])).toEqual(
      [],
    );
  });
});
