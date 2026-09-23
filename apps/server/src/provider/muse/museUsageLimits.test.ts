import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  MUSE_USAGE_READ_METHOD,
  museUsageChangedFrom,
  readMuseUsage,
  type MuseHost,
} from "./MuseMspRuntime.ts";
import { museUsageToLimits } from "./museUsageLimits.ts";

const CHECKED_AT = "2026-09-22T00:00:00.000Z";
/** Captured from a real host after it served one turn. */
const SESSION_RESET_MS = 1_790_090_902_000;
const WEEKLY_RESET_MS = 1_790_553_600_000;
const WEEK_MINS = 7 * 24 * 60;

/** The mapper formats resets through Effect's DateTime, not the global Date. */
const isoOf = (ms: number): string => DateTime.formatIso(Option.getOrThrow(DateTime.make(ms)));

/**
 * The `usage` member of `usage/read`'s `{ usage? }` result, verbatim from a
 * live host: the host omits the member entirely until it observes usage.
 */
const liveUsage = {
  observedAtMs: 1_790_081_742_245,
  tier: "27681631238169137",
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: SESSION_RESET_MS },
  weekly: { usedPercent: 12, resetsAtMs: WEEKLY_RESET_MS },
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
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: isoOf(SESSION_RESET_MS),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 12,
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
      expect(limits.unavailable?.message).toBe(
        usage === undefined
          ? "Muse Code has not observed subscription usage yet. Limits will appear after a Muse turn."
          : "Muse Code returned usage without readable windows.",
      );
    }
  });
});

describe("readMuseUsage", () => {
  const mockHost = (
    request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => ({ connection: { request } }) as unknown as Pick<MuseHost, "connection">;

  it.effect("calls usage/read and unwraps the documented usage member", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const host = mockHost(async (method, params) => {
        calls.push({ method, params });
        return { usage: liveUsage };
      });

      const usage = yield* readMuseUsage(host);

      expect(MUSE_USAGE_READ_METHOD).toBe("usage/read");
      expect(calls).toEqual([{ method: "usage/read", params: {} }]);
      expect(usage).toEqual(liveUsage);
    }),
  );

  it.effect("reports nothing when the host has observed no usage", () =>
    Effect.gen(function* () {
      const host = mockHost(async () => ({}));
      expect(yield* readMuseUsage(host)).toBeUndefined();
    }),
  );

  it.effect("reports nothing when the usage member is not a record", () =>
    Effect.gen(function* () {
      const host = mockHost(async () => ({ usage: "nope" }));
      expect(yield* readMuseUsage(host)).toBeUndefined();
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

describe("museUsageChangedFrom", () => {
  it("extracts the usage payload from a usage/changed notification", () => {
    expect(museUsageChangedFrom({ method: "usage/changed", params: liveUsage })).toEqual(liveUsage);
  });

  it("ignores other notifications and unusable params", () => {
    expect(museUsageChangedFrom({ method: "turn/started", params: liveUsage })).toBeUndefined();
    expect(museUsageChangedFrom({ method: "usage/changed" })).toBeUndefined();
    expect(museUsageChangedFrom({ method: "usage/changed", params: undefined })).toBeUndefined();
    expect(museUsageChangedFrom({ method: "usage/changed", params: { usage: liveUsage } })).toEqual(
      { usage: liveUsage },
    );
  });
});
