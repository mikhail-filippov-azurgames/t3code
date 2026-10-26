import { NodeServices } from "@effect/platform-node";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  kimiUsagePayloadToLimits,
  parseKimiManagedProviderConfig,
  probeKimiUsageLimits,
  resolveKimiCodeOAuthKey,
} from "./usageLimits.ts";

const checkedAt = "2026-10-26T12:00:00.000Z";

const CONFIG = `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
oauth_host = "https://auth.kimi.ai"
`;

const CREDENTIALS_FILE = "kimi-code-env-0e4f99c69cc27850.json";
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePersistedToken = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.String,
      refresh_token: Schema.String,
      expires_at: Schema.Number,
    }),
  ),
);

const usagePayload = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: "2026-10-26T14:20:51Z" },
    limit_month_total: { used_ratio: 0.1, reset_time: "2026-11-27T00:00:00Z" },
  },
};

describe("parseKimiManagedProviderConfig", () => {
  it("reads base_url and oauth_host from the managed provider's quoted section", () => {
    expect(parseKimiManagedProviderConfig(CONFIG)).toEqual({
      baseUrl: "https://api.kimi.ai/coding/v1",
      oauthHost: "https://auth.kimi.ai",
      apiKey: undefined,
      hasOAuth: true,
    });
  });

  it("ignores other providers and comments", () => {
    const text = `
# [providers."managed:kimi-code"]
[providers.other]
base_url = "https://example.com"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1" # trailing comment
`;
    expect(parseKimiManagedProviderConfig(text)).toEqual({
      baseUrl: "https://api.kimi.com/coding/v1",
      oauthHost: undefined,
      apiKey: undefined,
      hasOAuth: false,
    });
  });

  it("reports api key auth and missing oauth", () => {
    const text = `
[providers."managed:kimi-code"]
type = "kimi"
apiKey = "sk-test"
`;
    const config = parseKimiManagedProviderConfig(text);
    expect(config.apiKey).toBe("sk-test");
    expect(config.hasOAuth).toBe(false);
  });
});

describe("resolveKimiCodeOAuthKey", () => {
  it("uses the legacy slot for the shared default pair", () => {
    expect(
      resolveKimiCodeOAuthKey({
        oauthHost: "https://auth.kimi.com",
        baseUrl: "https://api.kimi.com/coding/v1",
      }),
    ).toBe("oauth/kimi-code");
    expect(
      resolveKimiCodeOAuthKey({
        oauthHost: "https://auth.kimi.com",
        baseUrl: "https://api.kimi.ai/coding/v1",
      }),
    ).toBe("oauth/kimi-code");
  });

  it("hashes a custom (oauth host, base URL) pair the way the CLI does", () => {
    expect(
      resolveKimiCodeOAuthKey({
        oauthHost: "https://auth.kimi.ai",
        baseUrl: "https://api.kimi.ai/coding/v1",
      }),
    ).toBe("oauth/kimi-code-env-0e4f99c69cc27850");
  });

  it("normalizes trailing slashes before comparing and hashing", () => {
    expect(
      resolveKimiCodeOAuthKey({
        oauthHost: "https://auth.kimi.ai/",
        baseUrl: "https://api.kimi.ai/coding/v1/",
      }),
    ).toBe("oauth/kimi-code-env-0e4f99c69cc27850");
  });
});

describe("kimiUsagePayloadToLimits", () => {
  it("maps the four plan windows from 0-1 ratios to percents", () => {
    const limits = kimiUsagePayloadToLimits({
      checkedAt,
      payload: {
        usages: {
          limit_5h: { used_ratio: 0.25, reset_time: "2026-10-26T14:20:51Z" },
          limit_7d: { used_ratio: 0.5, reset_time: "2026-11-02T00:00:00Z" },
          limit_month_total: { used_ratio: 0.1, reset_time: "2026-11-27T00:00:00Z" },
          limit_month_code: { used_ratio: 0.075, reset_time: "2026-11-27T00:00:00Z" },
        },
      },
    });
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "limit_5h",
        kind: "session",
        label: "5-hour",
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: "2026-10-26T14:20:51.000Z",
      },
      {
        id: "limit_7d",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 50,
        windowDurationMins: 10_080,
        resetsAt: "2026-11-02T00:00:00.000Z",
      },
      {
        id: "limit_month_code",
        kind: "monthly",
        label: "Monthly · Code",
        usedPercent: 7.5,
        resetsAt: "2026-11-27T00:00:00.000Z",
      },
      {
        id: "limit_month_total",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 10,
        resetsAt: "2026-11-27T00:00:00.000Z",
      },
    ]);
  });

  it("skips windows the plan does not report", () => {
    const limits = kimiUsagePayloadToLimits({
      checkedAt,
      payload: { usages: { limit_5h: { used_ratio: 0 } } },
    });
    expect(limits.windows.map((window) => window.id)).toEqual(["limit_5h"]);
  });

  it("clamps out-of-range ratios and accepts string ratios", () => {
    const limits = kimiUsagePayloadToLimits({
      checkedAt,
      payload: {
        usages: {
          limit_5h: { used_ratio: 1.4 },
          limit_7d: { used_ratio: "0.2" },
        },
      },
    });
    expect(limits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["limit_5h", 100],
      ["limit_7d", 20],
    ]);
  });

  it("drops windows without a usable ratio", () => {
    const limits = kimiUsagePayloadToLimits({
      checkedAt,
      payload: { usages: { limit_5h: { used_ratio: -1 }, limit_7d: {} } },
    });
    expect(limits.windows).toEqual([]);
  });

  it("flags malformed payloads as probe failures", () => {
    for (const payload of [null, "nope", { limits: [] }, { usages: null }]) {
      const limits = kimiUsagePayloadToLimits({ checkedAt, payload });
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.windows).toEqual([]);
    }
  });
});

interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
}

interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly header: (name: string) => string | null;
}

/** HttpClient double: routes by method + URL and answers with canned JSON. */
const makeFakeHttpClient = (handler: (request: FakeRequest) => FakeResponse) =>
  HttpClient.make((request) => {
    const headers = new Map<string, string>();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
    }
    const fake: FakeRequest = {
      method: request.method,
      url: request.url,
      header: (name) => headers.get(name.toLowerCase()) ?? null,
    };
    const { status, body } = handler(fake);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

describe("probeKimiUsageLimits", () => {
  const makeHome = Effect.fn("kimiUsageLimits.test.makeHome")(function* (
    config: string,
    credentials?: Record<string, unknown>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kimi-usage-test-" });
    yield* fileSystem.writeFileString(path.join(home, "config.toml"), config);
    if (credentials) {
      yield* fileSystem.makeDirectory(path.join(home, "credentials"));
      const text = yield* encodeUnknownJson(credentials);
      yield* fileSystem.writeFileString(path.join(home, "credentials", CREDENTIALS_FILE), text);
    }
    return home;
  });

  const nowSeconds = Effect.map(DateTime.now, (now) =>
    Math.floor(DateTime.toEpochMillis(now) / 1000),
  );

  const runProbe = (
    home: string,
    handler: (request: FakeRequest) => FakeResponse,
  ): Effect.Effect<ServerProviderUsageLimits, never, FileSystem.FileSystem | Path.Path> =>
    probeKimiUsageLimits({ homeDir: home }).pipe(
      Effect.provideService(HttpClient.HttpClient, makeFakeHttpClient(handler)),
    );

  const freshToken = (expiresAt: number) => ({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: expiresAt,
  });

  it.effect("reads windows with a fresh token", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(CONFIG, freshToken((yield* nowSeconds) + 900));
      const calls: FakeRequest[] = [];
      const limits = yield* runProbe(home, (request) => {
        calls.push(request);
        return { status: 200, body: usagePayload };
      });

      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows.map((window) => window.id)).toEqual(["limit_5h", "limit_month_total"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.kimi.ai/coding/v1/usages");
      expect(calls[0]?.header("Authorization")).toBe("Bearer access-token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refreshes an expired token and persists it for the CLI", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const home = yield* makeHome(CONFIG, {
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_at: now - 10,
      });
      const calls: FakeRequest[] = [];
      const limits = yield* runProbe(home, (request) => {
        calls.push(request);
        if (request.method === "POST") {
          expect(request.url).toBe("https://auth.kimi.ai/api/oauth/token");
          return {
            status: 200,
            body: { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 900 },
          };
        }
        expect(request.header("Authorization")).toBe("Bearer fresh-access");
        return { status: 200, body: usagePayload };
      });

      expect(limits.windows.map((window) => window.id)).toEqual(["limit_5h", "limit_month_total"]);
      expect(calls).toHaveLength(2);

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const persisted = yield* decodePersistedToken(
        yield* fileSystem.readFileString(path.join(home, "credentials", CREDENTIALS_FILE)),
      );
      expect(persisted.access_token).toBe("fresh-access");
      expect(persisted.refresh_token).toBe("fresh-refresh");
      expect(persisted.expires_at).toBe(now + 900);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unsupported when the provider has no oauth sign-in", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(`
[providers."managed:kimi-code"]
type = "kimi"
apiKey = "sk-test"
`);
      const limits = yield* runProbe(home, () => ({ status: 200, body: {} }));
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.windows).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unsupported when credentials are missing", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(CONFIG);
      const limits = yield* runProbe(home, () => ({ status: 200, body: {} }));
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.unavailable?.message).toContain("kimi login");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a probe failure when the token is rejected", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(CONFIG, freshToken((yield* nowSeconds) + 900));
      const limits = yield* runProbe(home, () => ({
        status: 401,
        body: { error: "unauthorized" },
      }));
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.unavailable?.message).toContain("kimi login");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a probe failure when the refresh fails", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(CONFIG, {
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_at: (yield* nowSeconds) - 10,
      });
      const limits = yield* runProbe(home, () => ({
        status: 400,
        body: { error: "invalid_grant" },
      }));
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.unavailable?.message).toContain("refresh");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
