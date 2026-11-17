import { UsageSource, UsageSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const { instances: _instances, ...legacyFields } = UsageSource.fields;
const LegacyUsageSource = Schema.Struct(legacyFields);
const decodeSummary = Schema.decodeUnknownSync(UsageSummary);
const decodeSource = Schema.decodeSync(UsageSource);
const decodeLegacySource = Schema.decodeUnknownSync(LegacyUsageSource);

const baseSource = {
  fingerprint: {
    hostId: "host",
    provider: "claude",
    resolvedHomePath: "/home/user/.claude-zavod",
    volumeId: "1:2",
  },
  status: "ok",
  scannedFiles: 3,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 2,
  message: null,
} as const;

const summaryWith = (source: unknown) => ({
  contractVersion: 6,
  readAt: "2026-11-17T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-11-01",
  untilDay: "2026-11-17",
  buckets: [],
  sources: [source],
  pricing: { status: "fresh", source: "local", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
});

describe("UsageSource.instances contract", () => {
  it("decodes an older response without instances", () => {
    const summary = decodeSummary(summaryWith(baseSource));
    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0]).not.toHaveProperty("instances");
  });

  it("decodes instances with and without a display name", () => {
    const source = decodeSource({
      ...baseSource,
      instances: [{ instanceId: "claudeZavod", displayName: "Zavod" }, { instanceId: "claude" }],
    });
    expect(source.instances).toEqual([
      { instanceId: "claudeZavod", displayName: "Zavod" },
      { instanceId: "claude" },
    ]);
  });

  it("lets a client that predates instances read the new response", () => {
    const legacy = decodeLegacySource({
      ...baseSource,
      instances: [{ instanceId: "claudeZavod", displayName: "Zavod" }],
    });
    expect(legacy.distinctSessions).toBe(2);
    expect(legacy).not.toHaveProperty("instances");
  });
});
