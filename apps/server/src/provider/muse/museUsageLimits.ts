/**
 * Muse Code subscription usage, read from the MSP host's `usage/read` method.
 *
 * The host reports a five-hour-class `window` and a rolling `weekly` block as
 * percentages with epoch-millisecond resets, plus the subscription `tier`. The
 * pinned `@muse-code/sdk` typings predate the method, so the runtime calls it
 * generically and this mapper reads the payload structurally.
 *
 * @module provider/muse/museUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

/** Window ids stay stable so a future runtime update can land on the same rows. */
const SESSION_WINDOW_ID = "window";
const WEEKLY_WINDOW_ID = "weekly";
/** The host usually sends `windowDurationMins`; the documented class is five hours. */
const SESSION_FALLBACK_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const NOT_OBSERVED_MESSAGE =
  "Muse Code has not observed subscription usage yet. Limits will appear after a Muse turn.";
const INVALID_USAGE_MESSAGE = "Muse Code returned usage without readable windows.";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function percentOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? clampPercent(value) : undefined;
}

function isoFromEpochMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/**
 * Maps `usage/read`'s `usage` member onto contract windows. A payload with no
 * usable percentage — including the omitted member the host sends before it has
 * observed anything — reports `probeFailed` rather than a zeroed bar.
 */
export function museUsageToLimits(input: {
  readonly usage: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const usage = recordOf(input.usage);
  const windows: ServerProviderUsageWindow[] = [];

  const session = recordOf(usage?.["window"]);
  const sessionPercent = percentOf(session?.["usedPercent"]);
  if (sessionPercent !== undefined) {
    const duration = session?.["windowDurationMins"];
    const windowDurationMins =
      typeof duration === "number" && Number.isInteger(duration) && duration > 0
        ? duration
        : SESSION_FALLBACK_MINS;
    const resetsAt = isoFromEpochMs(session?.["resetsAtMs"]);
    windows.push({
      id: SESSION_WINDOW_ID,
      kind: "session",
      label: "Session",
      usedPercent: sessionPercent,
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const weekly = recordOf(usage?.["weekly"]);
  const weeklyPercent = percentOf(weekly?.["usedPercent"]);
  if (weeklyPercent !== undefined) {
    const resetsAt = isoFromEpochMs(weekly?.["resetsAtMs"]);
    windows.push({
      id: WEEKLY_WINDOW_ID,
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyPercent,
      windowDurationMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  return windows.length > 0
    ? makeUsageLimits({ checkedAt: input.checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "probeFailed",
        message: input.usage === undefined ? NOT_OBSERVED_MESSAGE : INVALID_USAGE_MESSAGE,
      });
}
