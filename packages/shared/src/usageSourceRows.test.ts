import type { EnvironmentId, UsageSourceFingerprint } from "@t3tools/contracts";
import type { ProviderSourceBreakdown } from "./usageSourceBreakdown.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  sourceRowLabel,
  UNATTRIBUTED_SOURCE_LABEL,
  usageSourceRows,
} from "./usageSourceBreakdown.ts";

const fingerprint: UsageSourceFingerprint = {
  hostId: "host",
  provider: "claude",
  resolvedHomePath: "/zavod",
  volumeId: "1",
};
const zero = { costUsd: 0, totalTokens: 0, records: 0, unpricedRecords: 0, sessions: 0 };
const label = (instanceId: string, environmentId = "local", displayName?: string) => ({
  environmentId: environmentId as EnvironmentId,
  environmentLabel: environmentId,
  instanceId,
  ...(displayName === undefined ? {} : { displayName }),
});

describe("sourceRowLabel", () => {
  it("prefers display names and lists every instance once", () => {
    expect(sourceRowLabel([label("claudeAgent"), label("claudeZavod", "local", "Zavod")])).toBe(
      "claudeAgent, Zavod",
    );
  });

  it("names the environment when labels come from several", () => {
    expect(sourceRowLabel([label("zavod", "laptop"), label("zavod", "server")])).toBe(
      "zavod (laptop), zavod (server)",
    );
  });
});

describe("usageSourceRows", () => {
  it("shows nothing for a provider without labeled sources", () => {
    const breakdown: ProviderSourceBreakdown = {
      provider: "claude",
      rows: [],
      unattributed: { ...zero, costUsd: 5, records: 1 },
    };
    expect(usageSourceRows(breakdown)).toEqual([]);
    expect(usageSourceRows(undefined)).toEqual([]);
  });

  it("hides source rows with zero tokens", () => {
    const used = {
      key: "used",
      fingerprint,
      instances: [label("claudeZavod", "local", "Zavod")],
      ...zero,
      totalTokens: 12,
    };
    const idle = {
      key: "idle",
      fingerprint: { ...fingerprint, resolvedHomePath: "/idle" },
      instances: [label("claudeIdle", "local", "Idle")],
      ...zero,
      costUsd: 3,
      records: 2,
      sessions: 1,
    };
    expect(
      usageSourceRows({ provider: "claude", rows: [used, idle], unattributed: zero }).map(
        (r) => r.label,
      ),
    ).toEqual(["Zavod"]);
  });

  it("adds the remainder as a shared row only when it has tokens", () => {
    const row = {
      key: "k",
      fingerprint,
      instances: [label("claudeZavod", "local", "Zavod")],
      ...zero,
      totalTokens: 7,
    };
    expect(
      usageSourceRows({ provider: "claude", rows: [row], unattributed: zero }).map((r) => r.label),
    ).toEqual(["Zavod"]);
    expect(
      usageSourceRows({
        provider: "claude",
        rows: [row],
        unattributed: { ...zero, costUsd: 1, totalTokens: 2 },
      }).map((r) => [r.label, r.costUsd]),
    ).toEqual([
      ["Zavod", 0],
      [UNATTRIBUTED_SOURCE_LABEL, 1],
    ]);
    expect(
      usageSourceRows({
        provider: "claude",
        rows: [row],
        unattributed: { ...zero, costUsd: 1, records: 1, sessions: 1 },
      }).map((r) => r.label),
    ).toEqual(["Zavod"]);
  });

  it("returns no rows when nothing carried tokens", () => {
    const row = {
      key: "k",
      fingerprint,
      instances: [label("claudeZavod", "local", "Zavod")],
      ...zero,
      costUsd: 3,
      sessions: 2,
    };
    expect(
      usageSourceRows({ provider: "claude", rows: [row], unattributed: { ...zero, sessions: 1 } }),
    ).toEqual([]);
  });
});
