// @effect-diagnostics nodeBuiltinImport:off
/**
 * OpenCode Go subscription usage, read from the zen usage endpoint.
 *
 * The Go console renders rolling/weekly/monthly windows from a session-scoped
 * web page, but the same numbers are served as JSON to the Go API key at
 * `/zen/go/v1/usage`. T3 Code reads them with the credential OpenCode itself
 * stores, so the Limits view shows OpenCode beside the Codex rows.
 *
 * The endpoint is undocumented and outside OpenAPI: a failure degrades to an
 * `unavailable` probe rather than taking the provider snapshot with it, and a
 * missing credential publishes nothing.
 *
 * @module provider/Layers/openCodeGoUsageLimits
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveOpenCodeDataDirectory } from "../../usage/usageOpenCodeReader.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

/** Documented at `opencode.ai/docs/go`; serves the Go key's own windows. */
export const OPEN_CODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const USAGE_PROBE_TIMEOUT = "10 seconds";
const USAGE_PROBE_FAILED_MESSAGE = "Could not read OpenCode Go usage.";
const UNAVAILABLE_MESSAGE = "OpenCode did not report usage windows.";

interface WindowSpec {
  readonly key: string;
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly windowDurationMins: number;
}

/**
 * `rolling` is the documented five-hour window; `weekly` resets Monday 00:00
 * UTC; `monthly` is anchored to the subscription, approximated as 30 days the
 * same way the Codex mapper treats its monthly allowance.
 */
const WINDOW_SPECS: readonly WindowSpec[] = [
  {
    key: "rolling",
    id: "rolling",
    kind: "session",
    label: "Rolling",
    windowDurationMins: 5 * 60,
  },
  {
    key: "weekly",
    id: "weekly",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  },
  {
    key: "monthly",
    id: "monthly",
    kind: "monthly",
    label: "Monthly",
    windowDurationMins: 30 * 24 * 60,
  },
];

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/**
 * Maps the `usage` payload onto contract windows. A malformed body, or one
 * whose per-window percentage is missing, reports `probeFailed` rather than a
 * zeroed bar, so a bad read never reads as "no usage".
 */
export function parseOpenCodeGoUsage(body: unknown, checkedAt: string): ServerProviderUsageLimits {
  const usage = recordOf(recordOf(body)?.["usage"]);
  const windows: ServerProviderUsageWindow[] = [];
  for (const spec of WINDOW_SPECS) {
    const raw = recordOf(usage?.[spec.key]);
    const percent = raw?.["percent"];
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const resetsAt = isoInstant(raw?.["resetsAt"]);
    windows.push({
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      usedPercent: clampPercent(percent),
      windowDurationMins: spec.windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: UNAVAILABLE_MESSAGE,
      });
}

/** The Go bearer out of OpenCode's `auth.json`; a missing or empty key is absent. */
export function openCodeGoApiKeyFromAuthFile(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const key = recordOf(recordOf(parsed)?.["opencode-go"])?.["key"];
  if (typeof key !== "string") return undefined;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `$XDG_DATA_HOME/opencode/auth.json` else `~/.local/share/opencode/auth.json`. */
export function resolveOpenCodeAuthFilePath(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): string {
  return NodePath.join(resolveOpenCodeDataDirectory(environment, userHome), "auth.json");
}

/**
 * Reads Go usage for the signed-in account, or `undefined` when OpenCode holds
 * no Go credential. Every failure after a credential is found is a bounded
 * `probeFailed` window set: the raw body and the key never travel further.
 */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly environment: NodeJS.ProcessEnv;
  readonly checkedAt: string;
  readonly userHome?: string;
}): Effect.fn.Return<ServerProviderUsageLimits | undefined> {
  const authFilePath = resolveOpenCodeAuthFilePath(
    input.environment,
    input.userHome ?? NodeOS.homedir(),
  );
  const apiKey = yield* Effect.tryPromise(() => NodeFSP.readFile(authFilePath, "utf8")).pipe(
    Effect.map(openCodeGoApiKeyFromAuthFile),
    Effect.catchCause(() => Effect.succeed(undefined)),
  );
  if (apiKey === undefined) return undefined;

  const request = HttpClientRequest.get(OPEN_CODE_GO_USAGE_URL).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
    HttpClientRequest.setHeader("Accept", "application/json"),
  );
  return yield* input.httpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(USAGE_PROBE_TIMEOUT),
    Effect.map((body) => parseOpenCodeGoUsage(body, input.checkedAt)),
    Effect.catchCause(() =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt: input.checkedAt,
          reason: "probeFailed",
          message: USAGE_PROBE_FAILED_MESSAGE,
        }),
      ),
    ),
  );
});
