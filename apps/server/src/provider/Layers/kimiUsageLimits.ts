/**
 * Kimi Code subscription usage. The Kimi Code CLI keeps its managed-provider
 * OAuth token in `~/.kimi-code/credentials/` and the account's plan windows
 * behind `GET {baseUrl}/usages` on the coding API, authenticated with that
 * token. ACP has no usage surface, so the probe derives the same credential
 * slot the CLI writes (config `providers."managed:kimi-code"` base URL +
 * oauth host, hashed the way `kimi login` hashes them) and refreshes the
 * short-lived access token the same way. The response's `usages` map reports
 * each window as a 0–1 `used_ratio` with an ISO `reset_time`.
 *
 * @module provider/Layers/kimiUsageLimits
 */
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const KIMI_CODE_PROVIDER_NAME = "managed:kimi-code";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const GLOBAL_BASE_URL = "https://api.kimi.ai/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
/** Public OAuth client id of the Kimi Code CLI device flow. */
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_KEY = "oauth/kimi-code";
const OAUTH_KEY_ENV_PREFIX = "oauth/kimi-code-env-";
const USAGE_TIMEOUT_MS = 8_000;
/** Tokens live ~15 minutes; refresh a bit early to stay ahead of clock skew. */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOW_DEFS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  limit_5h: { kind: "session", label: "5-hour", windowDurationMins: SESSION_MINS },
  limit_7d: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
  limit_month_total: { kind: "monthly", label: "Monthly" },
  limit_month_code: { kind: "monthly", label: "Monthly · Code" },
};

class KimiUsageProbeError extends Data.TaggedError("KimiUsageProbeError")<{
  readonly cause: unknown;
}> {}

/** Wire shape of the CLI's credential file, as `kimi login` writes it. */
const TokenWireSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_at: Schema.Number,
  scope: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
});
const TokenWireJson = Schema.fromJsonString(TokenWireSchema);
/** The CLI writes its credential files pretty-printed; keep that shape. */
const TokenWireJsonPretty = fromJsonStringPretty(TokenWireSchema);

export interface KimiManagedProviderConfig {
  readonly baseUrl: string | undefined;
  readonly oauthHost: string | undefined;
  /** Present when the provider is signed in with an API key instead of OAuth. */
  readonly apiKey: string | undefined;
  /** Present when the provider has an oauth section at all. */
  readonly hasOAuth: boolean;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

/**
 * Split a TOML section header into path segments, honoring quoted segments
 * (`[providers."managed:kimi-code".oauth]`) so dots and colons inside quotes
 * do not split.
 */
function parseSectionPath(header: string): ReadonlyArray<string> | undefined {
  const segments: string[] = [];
  let current = "";
  let inString = false;
  for (const ch of header.trim()) {
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === "." && !inString) {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current.trim());
  return inString || segments.some((segment) => segment.length === 0) ? undefined : segments;
}

function parseStringValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
  return unescapeTomlString(trimmed.slice(1, -1));
}

/** TOML basic strings share JSON's common escapes; URLs only ever hit these. */
function unescapeTomlString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
}

/** Minimal JSON string quoting, byte-identical to `JSON.stringify` for values without control characters beyond the common escapes. */
function quoteJsonString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")}"`;
}

/**
 * Read the `managed:kimi-code` provider record out of `config.toml`. Only
 * the small surface the usage probe needs is parsed: string values inside the
 * provider section and its `oauth` sub-section.
 */
export function parseKimiManagedProviderConfig(configText: string): KimiManagedProviderConfig {
  let baseUrl: string | undefined;
  let oauthHost: string | undefined;
  let apiKey: string | undefined;
  let hasOAuth = false;
  let section: ReadonlyArray<string> = [];
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        section = [];
        continue;
      }
      section = parseSectionPath(line.slice(1, -1)) ?? [];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseStringValue(line.slice(eq + 1));
    if (value === undefined) continue;
    const [head, provider, sub] = section;
    if (head !== "providers" || provider !== KIMI_CODE_PROVIDER_NAME) continue;
    if (sub === undefined) {
      if (key === "base_url") baseUrl = value;
      if (key === "apiKey") apiKey = value;
    } else if (sub === "oauth") {
      hasOAuth = true;
      if (key === "oauth_host") oauthHost = value;
    }
  }
  return { baseUrl, oauthHost, apiKey, hasOAuth };
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const SHARED_DEFAULT_BASE_URLS = new Set(
  [DEFAULT_BASE_URL, GLOBAL_BASE_URL].map((url) => normalizeEndpoint(url)),
);

/**
 * The credential slot `kimi login` writes for an (oauth host, base URL)
 * pair: the shared default pair keeps the legacy `oauth/kimi-code` slot;
 * anything else gets a stable hash of the pair, first 16 hex chars.
 */
export function resolveKimiCodeOAuthKey(input: {
  readonly oauthHost: string;
  readonly baseUrl: string;
}): string {
  const oauthHost = normalizeEndpoint(input.oauthHost);
  const baseUrl = normalizeEndpoint(input.baseUrl);
  if (
    oauthHost === normalizeEndpoint(DEFAULT_OAUTH_HOST) &&
    SHARED_DEFAULT_BASE_URLS.has(baseUrl)
  ) {
    return OAUTH_KEY;
  }
  const hash = createHash("sha256")
    .update(`{"oauthHost":${quoteJsonString(oauthHost)},"baseUrl":${quoteJsonString(baseUrl)}}`)
    .digest("hex")
    .slice(0, 16);
  return `${OAUTH_KEY_ENV_PREFIX}${hash}`;
}

function isoFromString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function usedPercentFromRatio(value: unknown): number | undefined {
  const ratio =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(ratio) || ratio < 0) return undefined;
  // The API reports a 0–1 fraction; a fraction slightly past 1 (rounding)
  // saturates at 100%.
  return clampPercent(ratio * 100);
}

/**
 * Map the `/usages` payload to contract windows. A window the account does
 * not have (plan without a 7-day limit) is simply absent from `usages` and
 * is skipped here, matching Kimi's own usage panel.
 */
export function kimiUsagePayloadToLimits(input: {
  readonly payload: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const { payload, checkedAt } = input;
  if (typeof payload !== "object" || payload === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Kimi returned an unexpected usage response.",
    });
  }
  const usages = (payload as Record<string, unknown>)["usages"];
  if (typeof usages !== "object" || usages === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Kimi returned an unexpected usage response.",
    });
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, def] of Object.entries(WINDOW_DEFS)) {
    const entry = (usages as Record<string, unknown>)[id];
    if (typeof entry !== "object" || entry === null) continue;
    const usedPercent = usedPercentFromRatio((entry as Record<string, unknown>)["used_ratio"]);
    if (usedPercent === undefined) continue;
    const resetsAt = isoFromString((entry as Record<string, unknown>)["reset_time"]);
    windows.push({
      id,
      kind: def.kind,
      label: def.label,
      usedPercent,
      ...(def.windowDurationMins !== undefined
        ? { windowDurationMins: def.windowDurationMins }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Run one request and collect status + JSON body. Transport errors, malformed
 * JSON, and timeouts all collapse to `None`; callers only need the payload.
 */
const runRequest = (
  request: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) =>
  Effect.gen(function* () {
    const response = yield* request;
    const body = yield* response.json;
    return { status: response.status, body } satisfies JsonResponse;
  }).pipe(
    Effect.mapError((cause) => new KimiUsageProbeError({ cause })),
    Effect.option,
    Effect.timeoutOption(Duration.millis(USAGE_TIMEOUT_MS)),
    Effect.map(Option.flatten),
  );

function resolveKimiHome(environment: NodeJS.ProcessEnv, paths: Path.Path): string {
  const override = environment["KIMI_CODE_HOME"];
  if (override !== undefined && override.length > 0) return override;
  return paths.join(os.homedir(), ".kimi-code");
}

/**
 * Read the signed-in Kimi account's plan windows. Never fails: every failure
 * mode lands on an `unavailable` snapshot with a message the Limits view can
 * show, and a failed probe keeps the last good bars downstream.
 */
export const probeKimiUsageLimits = Effect.fn("probeKimiUsageLimits")(function* (input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): Effect.fn.Return<
  ServerProviderUsageLimits,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = input.environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
  const home = input.homeDir ?? resolveKimiHome(environment, paths);

  const configText = yield* fs.readFileString(paths.join(home, "config.toml")).pipe(Effect.option);
  const config = parseKimiManagedProviderConfig(Option.getOrElse(configText, () => ""));

  if (!config.hasOAuth) {
    return config.apiKey !== undefined
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "The managed Kimi provider uses an API key; it has no subscription quota.",
        })
      : makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Sign in with `kimi login` to see Kimi plan usage.",
        });
  }

  const baseUrl = config.baseUrl ?? environment["KIMI_CODE_BASE_URL"] ?? DEFAULT_BASE_URL;
  const oauthHost =
    config.oauthHost ??
    environment["KIMI_CODE_OAUTH_HOST"] ??
    environment["KIMI_OAUTH_HOST"] ??
    DEFAULT_OAUTH_HOST;

  const storageName = resolveKimiCodeOAuthKey({ oauthHost, baseUrl }).replace(/^oauth\//, "");
  const credentialsPath = paths.join(home, "credentials", `${storageName}.json`);
  const token = yield* fs.readFileString(credentialsPath).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(TokenWireJson)(text)),
    Effect.mapError((cause) => new KimiUsageProbeError({ cause })),
    Effect.option,
  );
  if (Option.isNone(token)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Sign in with `kimi login` to see Kimi plan usage.",
    });
  }

  let accessToken = token.value.access_token;
  if (token.value.expires_at - nowSeconds < TOKEN_EXPIRY_SKEW_SECONDS) {
    if (!token.value.refresh_token) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "The Kimi sign-in token expired without a refresh token; run `kimi login`.",
      });
    }
    const refreshed = yield* runRequest(
      httpClient.post(`${normalizeEndpoint(oauthHost)}/api/oauth/token`, {
        acceptJson: true,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: HttpBody.urlParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: token.value.refresh_token,
        }),
      }),
    );
    if (Option.isNone(refreshed)) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not refresh the Kimi sign-in token; run `kimi login`.",
      });
    }
    const { status, body: payload } = refreshed.value;
    if (
      status !== 200 ||
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as Record<string, unknown>)["access_token"] !== "string"
    ) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not refresh the Kimi sign-in token; run `kimi login`.",
      });
    }
    const data = payload as Record<string, unknown>;
    accessToken = data["access_token"] as string;
    // Publish the rotated token back to the CLI's slot (tmp + rename, same
    // wire shape) so both processes keep working. A failed write is logged
    // by the caller's next refresh, not fatal here.
    const suffix = yield* Random.nextInt;
    const tmpPath = `${credentialsPath}.tmp.${suffix}`;
    yield* Schema.encodeEffect(TokenWireJsonPretty)({
      ...token.value,
      access_token: accessToken,
      ...(typeof data["refresh_token"] === "string"
        ? { refresh_token: data["refresh_token"] }
        : {}),
      expires_at: nowSeconds + (typeof data["expires_in"] === "number" ? data["expires_in"] : 0),
    }).pipe(
      Effect.flatMap((text) => fs.writeFileString(tmpPath, text)),
      Effect.andThen(fs.rename(tmpPath, credentialsPath)),
      Effect.ignoreCause,
      Effect.asVoid,
    );
  }

  const usage = yield* runRequest(
    httpClient.get(`${normalizeEndpoint(baseUrl)}/usages`, {
      acceptJson: true,
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  );
  if (Option.isNone(usage)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Timed out reading Kimi plan usage.",
    });
  }
  if (usage.value.status === 401 || usage.value.status === 403) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Kimi rejected the sign-in token; run `kimi login`.",
    });
  }
  if (usage.value.status !== 200) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: `Kimi usage request failed (HTTP ${usage.value.status}).`,
    });
  }
  return kimiUsagePayloadToLimits({ payload: usage.value.body, checkedAt });
});
