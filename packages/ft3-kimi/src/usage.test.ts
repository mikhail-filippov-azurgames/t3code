import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { kimiUsageReader, parseKimiWireLine } from "./usage.ts";

const settings = {
  source: "local",
  enabled: true,
  agentId: "kimi",
  commandPath: "C:\\Tools\\kimi.exe",
  commandArgs: ["acp"],
  authMethodId: "",
  distribution: "auto",
  customModels: [],
} satisfies AcpRegistrySettings;

const wireLine = (time: number, inputOther = 100, output = 20) =>
  JSON.stringify({
    type: "usage.record",
    agentId: "main",
    model: "kimi-code/kimi-for-coding",
    usage: {
      inputOther,
      output,
      inputCacheRead: 10,
      inputCacheCreation: 0,
    },
    usageScope: "turn",
    time,
  });

describe("parseKimiWireLine", () => {
  it("reads one turn's token totals and ignores non-usage lines", () => {
    expect(parseKimiWireLine(wireLine(1_790_000_000_000), "abc", 3)).toMatchObject({
      provider: "kimi",
      timestampMs: 1_790_000_000_000,
      model: "kimi-code/kimi-for-coding",
      sessionId: "abc",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 10,
        cacheCreationTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
      },
      dedupeKey: "kimi:abc:3",
    });
    expect(parseKimiWireLine('{"type":"metadata"}', "abc", 0)).toBeNull();
    expect(parseKimiWireLine("{not json usage.record", "abc", 0)).toBeNull();
  });
});

describe("kimiUsageReader", () => {
  it.effect("scans Kimi session wire files for the requested window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kimi-usage-test-" });
      const agentDir = path.join(home, "sessions", "wd_project", "session_abc", "agents", "main");
      yield* fileSystem.makeDirectory(agentDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(agentDir, "wire.jsonl"),
        [
          wireLine(1_000_000, 1, 1),
          wireLine(3_000_000, 100, 20),
          wireLine(4_000_000, 200, 40),
          "",
        ].join("\n"),
      );

      const [source] = yield* kimiUsageReader.scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("kimi"),
            config: settings,
            environment: { KIMI_CODE_HOME: home },
            configured: true,
          },
        ],
        settings: {} as never,
        windowStartMs: 2_000_000,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      });

      expect(source?.dir).toBe(path.join(home, "sessions"));
      expect(source?.files?.map((file) => file.records.length)).toEqual([2]);
      expect(
        source?.files?.[0]?.records.map((record) => record.totals.uncachedInputTokens),
      ).toEqual([100, 200]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Kimi out of sources when no instance is configured", () =>
    Effect.gen(function* () {
      const [source] = yield* kimiUsageReader.scan({
        instances: [],
        settings: {} as never,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      });
      expect(source).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
