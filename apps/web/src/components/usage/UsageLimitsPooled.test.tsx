import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:00:00.000Z";

const sessionWindow = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

// Hub accounts without a redeemable credit render the plain popover path,
// so the bar renders with no reset-credit or settings hooks involved.
function hubPresentations(driver: string, emails: readonly string[]) {
  return new Map([
    [
      EnvironmentId.make("env-a"),
      {
        entry: { target: { label: "Laptop" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy" as const,
              label: "hub",
              checkedAt,
              accounts: emails.map((email) => ({
                id: `${driver}-${email}.json`,
                driver: ProviderDriverKind.make(driver),
                email,
                usageLimits: { checkedAt, windows: [{ ...sessionWindow }] },
              })),
            },
          ],
        },
      },
    ],
  ]);
}

describe("UsageLimitsPooled single account", () => {
  it("labels the segment itself with no index numeral or legend", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        presentations={hubPresentations("codex", ["solo@example.com"])}
        now={now}
      />,
    );
    expect(markup).toContain("60%");
    expect(markup).toContain("repeat(1, minmax(0, 1fr))");
    // The label sits on the segment at every width instead of waiting on a container query.
    expect(markup).toContain("px-2 text-xs flex");
    // No strip numeral, no legend row, nothing gated on the wide container.
    expect(markup).not.toContain(">1<");
    expect(markup).not.toContain("@2xl/pool:hidden");
    expect(markup).not.toContain("Segment </span>");
  });

  it("keeps the stale-data note for a lone Muse account", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        presentations={hubPresentations("museCode", ["solo@example.com"])}
        now={now}
      />,
    );
    expect(markup).toContain("Showing last received usage data");
    expect(markup).toContain("60%");
    expect(markup).not.toContain(">1<");
    expect(markup).not.toContain("@2xl/pool:hidden");
  });
});

describe("UsageLimitsPooled several accounts", () => {
  it("keeps strip numerals and the legend mapping them", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        presentations={hubPresentations("codex", ["first@example.com", "second@example.com"])}
        now={now}
      />,
    );
    expect(markup).toContain("repeat(2, minmax(0, 1fr))");
    expect(markup).toContain(">1<");
    expect(markup).toContain(">2<");
    expect(markup).toContain("Segment </span>");
    expect(markup).toContain("@2xl/pool:hidden");
    expect(markup).toContain("hidden @2xl/pool:flex");
  });
});
