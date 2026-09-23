import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeMuseUsageCache, museUsageCachePath } from "./MuseUsageCache.ts";

const TEST_NOW_MS = 1_800_000_000_000;
const TEST_NOW_NS = BigInt(TEST_NOW_MS) * 1_000_000n;
const testClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => TEST_NOW_MS,
  currentTimeMillis: Effect.succeed(TEST_NOW_MS),
  currentTimeNanosUnsafe: () => TEST_NOW_NS,
  currentTimeNanos: Effect.succeed(TEST_NOW_NS),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void,
};

describe("MuseUsageCache", () => {
  it.effect(
    "restores the last observation after a new cache instance and clears it on logout",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-muse-usage-" });
        const cachePath = yield* museUsageCachePath(stateDir, ProviderInstanceId.make("muse-one"));
        const observedAtMs = 1_700_000_000_000;
        const first = yield* makeMuseUsageCache(cachePath);
        yield* first.observe({
          observedAtMs,
          tier: "subscription",
          window: { usedPercent: 24, windowDurationMins: 300 },
          weekly: { usedPercent: 9 },
        });
        yield* first.observe({
          observedAtMs: observedAtMs + 1_000,
          tier: "subscription",
          window: { usedPercent: 26, windowDurationMins: 300 },
          weekly: { usedPercent: 9 },
        });
        const persisted = yield* fileSystem.readFileString(cachePath);
        expect(persisted).not.toContain('"tier"');
        expect(persisted).not.toContain('"observedAtMs"');

        const afterRestart = yield* makeMuseUsageCache(cachePath);
        const restored = yield* afterRestart.read;
        expect(restored?.checkedAt).toBe(
          DateTime.formatIso(DateTime.makeUnsafe(observedAtMs + 1_000)),
        );
        expect(restored?.windows.map((window) => window.usedPercent)).toEqual([26, 9]);

        yield* afterRestart.clear;
        yield* afterRestart.clear;
        const afterLogout = yield* makeMuseUsageCache(cachePath);
        expect(yield* afterLogout.read).toBeUndefined();
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.provideService(Clock.Clock, testClock),
      ),
  );

  it.effect("preserves loaded bars when the persisted cache becomes malformed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-muse-usage-" });
      const cachePath = yield* museUsageCachePath(stateDir, ProviderInstanceId.make("muse-one"));
      const observedAtMs = 1_700_000_000_000;
      const first = yield* makeMuseUsageCache(cachePath);
      yield* first.observe({
        observedAtMs,
        tier: "subscription",
        window: { usedPercent: 24, windowDurationMins: 300 },
      });

      const loaded = yield* makeMuseUsageCache(cachePath);
      const previous = yield* loaded.read;
      expect(previous?.windows.map((window) => window.usedPercent)).toEqual([24]);

      yield* fileSystem.writeFileString(
        cachePath,
        '{"checkedAt":"2023-11-14T22:13:20.000Z","windows":[{"id":"window","kind":"session","label":"Session","usedPercent":124}]}',
      );
      expect(yield* loaded.read).toEqual(previous);

      const afterRestart = yield* makeMuseUsageCache(cachePath);
      expect(yield* afterRestart.read).toBeUndefined();
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(Clock.Clock, testClock),
    ),
  );

  it.effect("uses separate cache files for separate provider instances", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const first = yield* museUsageCachePath("/state", ProviderInstanceId.make("muse-one"));
      const second = yield* museUsageCachePath("/state", ProviderInstanceId.make("muse-two"));
      expect(first).not.toBe(second);
      expect(first).not.toContain("muse-one");
      expect(path.dirname(first)).toBe(path.dirname(second));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
