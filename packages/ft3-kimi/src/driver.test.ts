import { ServerProvider, type ServerProviderUsageLimits } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { isKimiAcpSettings, withKimiUsageLimits } from "./driver.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const settings = (input: {
  source: "registry" | "local";
  agentId?: string;
  commandPath?: string;
}) =>
  decodeSettings({
    source: input.source,
    agentId: input.agentId ?? "",
    commandPath: input.commandPath ?? "",
  });

describe("isKimiAcpSettings", () => {
  it("matches the registry agent id", () => {
    expect(isKimiAcpSettings(settings({ source: "registry", agentId: "kimi" }))).toBe(true);
    expect(isKimiAcpSettings(settings({ source: "registry", agentId: "Kimi" }))).toBe(true);
    expect(isKimiAcpSettings(settings({ source: "registry", agentId: "kimi-code" }))).toBe(false);
    expect(isKimiAcpSettings(settings({ source: "registry", agentId: "devin" }))).toBe(false);
  });

  it("matches a local kimi executable", () => {
    expect(
      isKimiAcpSettings(settings({ source: "local", commandPath: "C:\\Tools\\kimi.exe" })),
    ).toBe(true);
    expect(
      isKimiAcpSettings(settings({ source: "local", commandPath: "/usr/local/bin/kimi" })),
    ).toBe(true);
    expect(
      isKimiAcpSettings(settings({ source: "local", commandPath: "C:\\Tools\\kimi-acp.exe" })),
    ).toBe(false);
    expect(isKimiAcpSettings(settings({ source: "local" }))).toBe(false);
  });
});

const decodeProvider = Schema.decodeSync(ServerProvider);

const providerSnapshot = (checkedAt: string, enabled = true) =>
  decodeProvider({
    instanceId: "acpRegistry-kimi",
    driver: "acpRegistry",
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt,
    models: [],
  });

const limits = (checkedAt: string): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [{ id: "limit_5h", kind: "session", label: "5-hour", usedPercent: 25 }],
});

const makeBaseSnapshot = (input: {
  readonly current: ReturnType<typeof providerSnapshot>;
  readonly onApplyUsageLimits?: () => void;
}): ManagedServerProvider => ({
  resolveMaintenance: () => Effect.die("unused"),
  applyUsageLimits: () => Effect.sync(() => input.onApplyUsageLimits?.()),
  getSnapshot: Effect.succeed(input.current),
  refresh: Effect.succeed(input.current),
  streamChanges: Stream.make(input.current),
});

describe("withKimiUsageLimits", () => {
  it.effect("adds limits to reads and caches them between reads", () =>
    Effect.gen(function* () {
      const current = providerSnapshot("2026-10-26T12:00:00.000Z");
      let probes = 0;
      const wrapped = yield* withKimiUsageLimits({
        snapshot: makeBaseSnapshot({ current }),
        probe: Effect.sync(() => {
          probes += 1;
          return limits("2026-10-26T12:00:00.000Z");
        }),
      });

      const first = yield* wrapped.getSnapshot;
      const second = yield* wrapped.getSnapshot;

      expect(first.usageLimits?.windows[0]?.usedPercent).toBe(25);
      expect(second.usageLimits?.windows[0]?.usedPercent).toBe(25);
      expect(probes).toBe(1);
    }),
  );

  it.effect("forces a fresh probe on refresh", () =>
    Effect.gen(function* () {
      const current = providerSnapshot("2026-10-26T12:00:00.000Z");
      let probes = 0;
      const wrapped = yield* withKimiUsageLimits({
        snapshot: makeBaseSnapshot({ current }),
        probe: Effect.sync(() => {
          probes += 1;
          return limits(`2026-10-26T12:00:0${probes}.000Z`);
        }),
      });

      yield* wrapped.getSnapshot;
      const refreshed = yield* wrapped.refresh;

      expect(probes).toBe(2);
      expect(refreshed.usageLimits?.checkedAt).toBe("2026-10-26T12:00:02.000Z");
    }),
  );

  it.effect("decorates streamed snapshots and delegates usage updates", () =>
    Effect.gen(function* () {
      const current = providerSnapshot("2026-10-26T12:00:00.000Z");
      let applied = 0;
      const wrapped = yield* withKimiUsageLimits({
        snapshot: makeBaseSnapshot({ current, onApplyUsageLimits: () => (applied += 1) }),
        probe: Effect.succeed(limits("2026-10-26T12:00:00.000Z")),
      });

      const streamed = yield* Stream.runCollect(wrapped.streamChanges);
      yield* wrapped.applyUsageLimits({
        checkedAt: "2026-10-26T12:00:00.000Z",
        windows: [],
      });

      expect([...streamed][0]?.usageLimits?.windows[0]?.id).toBe("limit_5h");
      expect(applied).toBe(1);
    }),
  );

  it.effect("leaves a disabled instance untouched", () =>
    Effect.gen(function* () {
      const current = providerSnapshot("2026-10-26T12:00:00.000Z", false);
      let probes = 0;
      const wrapped = yield* withKimiUsageLimits({
        snapshot: makeBaseSnapshot({ current }),
        probe: Effect.sync(() => {
          probes += 1;
          return limits("2026-10-26T12:00:00.000Z");
        }),
      });

      const read = yield* wrapped.getSnapshot;

      expect(read.usageLimits).toBeUndefined();
      expect(probes).toBe(0);
    }),
  );
});
