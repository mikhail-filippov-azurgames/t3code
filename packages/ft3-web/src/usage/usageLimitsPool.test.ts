import { ProviderDriverKind } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { limitPoolDisplayName } from "./usageLimitsPool.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

const named = (driver: LimitAccount["driver"], displayName: string): LimitAccount => ({
  key: `${driver}:${displayName}`,
  driver,
  displayName,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] },
});

describe("limitPoolDisplayName", () => {
  it("names an ACP pool after its Kimi instance", () => {
    const [pool] = collectLimitPools([named(ProviderDriverKind.make("acpRegistry"), "Kimi")], now);
    expect(limitPoolDisplayName(pool!)).toBe("Kimi");
  });

  it("keeps the generic ACP name when instances disagree", () => {
    const [pool] = collectLimitPools(
      [
        named(ProviderDriverKind.make("acpRegistry"), "Kimi"),
        named(ProviderDriverKind.make("acpRegistry"), "Devin"),
      ],
      now,
    );
    expect(limitPoolDisplayName(pool!)).toBeNull();
  });

  it("keeps branded drivers on their own label", () => {
    const [pool] = collectLimitPools([named(ProviderDriverKind.make("codex"), "Work")], now);
    expect(limitPoolDisplayName(pool!)).toBeNull();
  });
});
