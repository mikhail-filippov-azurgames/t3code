import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { MUSE_USAGE_READ_METHOD, readMuseUsage, type MuseHost } from "./MuseMspRuntime.ts";
import { museUsageToLimits } from "./museUsageLimits.ts";

const CHECKED_AT = "2026-09-22T00:00:00.000Z";
const SESSION_RESET_MS = 1_759_000_000_123;
const WEEKLY_RESET_MS = 1_759_500_000_456;
const WEEK_MINS = 7 * 24 * 60;

/** The mapper formats resets through Effect's DateTime, not the global Date. */
const isoOf = (ms: number): string => DateTime.formatIso(Option.getOrThrow(DateTime.make(ms)));

/** The shape `usage/read` returns once the host has observed usage. */
const liveUsage = {
  observedAtMs: 1_758_999_999_000,
  tier: "pro",
  window: { usedPercent: 42, windowDurationMins: 300, resetsAtMs: SESSION_RESET_MS },
  weekly: { usedPercent: 63, resetsAtMs: WEEKLY_RESET_MS },
};

describe("museUsageToLimits", () => {
  it("maps the session window and weekly block with resets", () => {
    const limits = museUsageToLimits({ usage: liveUsage, checkedAt: CHECKED_AT });
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: 42,
        windowDurationMins: 300,
        resetsAt: isoOf(SESSION_RESET_MS),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 63,
        windowDurationMins: WEEK_MINS,
        resetsAt: isoOf(WEEKLY_RESET_MS),
      },
    ]);
  });

  it("clamps over-100 percent, falls back the duration, and drops a bad reset", () => {
    const limits = museUsageToLimits({
      usage: { window: { usedPercent: 140, windowDurationMins: 0, resetsAtMs: -5 } },
      checkedAt: CHECKED_AT,
    });
    expect(limits.windows).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        windowDurationMins: 5 * 60,
      },
    ]);
  });

  it("keeps a weekly-only payload", () => {
    const limits = museUsageToLimits({
      usage: { weekly: { usedPercent: 7, resetsAtMs: WEEKLY_RESET_MS } },
      checkedAt: CHECKED_AT,
    });
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 7,
        windowDurationMins: WEEK_MINS,
        resetsAt: isoOf(WEEKLY_RESET_MS),
      },
    ]);
  });

  it("reports probeFailed rather than a zeroed bar when no percent is usable", () => {
    for (const usage of [
      undefined,
      {},
      { window: {} },
      { window: { usedPercent: "12" } },
      { window: { usedPercent: Number.NaN } },
      { weekly: { usedPercent: null } },
      null,
      "not json",
    ]) {
      const limits = museUsageToLimits({ usage, checkedAt: CHECKED_AT });
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }
  });
});

describe("readMuseUsage", () => {
  const mockHost = (
    command: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => ({ connection: { command } }) as unknown as Pick<MuseHost, "connection">;

  it.effect("calls usage/read with no parameters and returns the payload", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const host = mockHost(async (method, params) => {
        calls.push({ method, params });
        return liveUsage;
      });

      const usage = yield* readMuseUsage(host);

      expect(MUSE_USAGE_READ_METHOD).toBe("usage/read");
      expect(calls).toEqual([{ method: "usage/read", params: {} }]);
      expect(usage).toEqual(liveUsage);
    }),
  );

  it.effect("fails with the usage/read failure code when the host rejects", () =>
    Effect.gen(function* () {
      const host = mockHost(async () => {
        throw new Error("host gone");
      });

      const failure = yield* Effect.flip(readMuseUsage(host));

      expect(failure).toBeInstanceOf(ProviderAdapterRequestError);
      expect(failure.method).toBe("usage/read");
    }),
  );
});
