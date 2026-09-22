// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  OPEN_CODE_GO_USAGE_URL,
  openCodeGoApiKeyFromAuthFile,
  parseOpenCodeGoUsage,
  readOpenCodeGoUsageLimits,
  resolveOpenCodeAuthFilePath,
} from "./openCodeGoUsageLimits.ts";

const CHECKED_AT = "2026-09-22T00:00:00.000Z";
/** The repo's effect diagnostics reject raw `JSON.stringify`; encode through Schema. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The exact shape the zen usage endpoint returns for a Go key. */
const liveBody = {
  usage: {
    rolling: { status: "ok", percent: 5, resetsAt: "2026-09-22T14:03:10.197Z" },
    weekly: { status: "ok", percent: 63, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 54, resetsAt: "2026-10-06T11:55:31.000Z" },
  },
};

/** Writes `<dir>/opencode/auth.json`, the layout the data-dir convention expects. */
function makeAuthFile(contents: string): {
  readonly dataHome: string;
  readonly authFilePath: string;
} {
  const dataHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-go-"));
  const openCodeDir = NodePath.join(dataHome, "opencode");
  NodeFS.mkdirSync(openCodeDir);
  const authFilePath = NodePath.join(openCodeDir, "auth.json");
  NodeFS.writeFileSync(authFilePath, contents, "utf8");
  return { dataHome, authFilePath };
}

function removeAuthFile(dataHome: string): void {
  NodeFS.rmSync(dataHome, { recursive: true, force: true });
}

describe("parseOpenCodeGoUsage", () => {
  it("maps the rolling, weekly, and monthly windows", () => {
    const limits = parseOpenCodeGoUsage(liveBody, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "rolling",
        kind: "session",
        label: "Rolling",
        usedPercent: 5,
        windowDurationMins: 300,
        resetsAt: "2026-09-22T14:03:10.197Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 63,
        windowDurationMins: 10080,
        resetsAt: "2026-09-28T00:00:00.000Z",
      },
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 54,
        windowDurationMins: 43200,
        resetsAt: "2026-10-06T11:55:31.000Z",
      },
    ]);
  });

  it("clamps out-of-range percentages and drops an unparseable reset", () => {
    const limits = parseOpenCodeGoUsage(
      { usage: { rolling: { percent: 140, resetsAt: "not-a-date" } } },
      CHECKED_AT,
    );
    expect(limits.windows).toEqual([
      {
        id: "rolling",
        kind: "session",
        label: "Rolling",
        usedPercent: 100,
        windowDurationMins: 300,
      },
    ]);
  });

  it("reports probeFailed rather than a zeroed window when no percentage is usable", () => {
    for (const body of [
      {},
      { usage: {} },
      { usage: { rolling: { status: "error" } } },
      { usage: { rolling: { percent: "12" } } },
      null,
      "not json",
    ]) {
      const limits = parseOpenCodeGoUsage(body, CHECKED_AT);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }
  });
});

describe("openCodeGoApiKeyFromAuthFile", () => {
  it("reads the Go key and ignores blank or malformed entries", () => {
    expect(
      openCodeGoApiKeyFromAuthFile(encodeJson({ "opencode-go": { type: "api", key: "sk-go" } })),
    ).toBe("sk-go");
    expect(openCodeGoApiKeyFromAuthFile(encodeJson({ "opencode-go": { type: "api" } }))).toBe(
      undefined,
    );
    expect(openCodeGoApiKeyFromAuthFile(encodeJson({ "opencode-go": { key: "  " } }))).toBe(
      undefined,
    );
    expect(openCodeGoApiKeyFromAuthFile(encodeJson({ opencode: { key: "sk-zen" } }))).toBe(
      undefined,
    );
    expect(openCodeGoApiKeyFromAuthFile("{")).toBe(undefined);
  });
});

describe("resolveOpenCodeAuthFilePath", () => {
  it("prefers XDG_DATA_HOME and falls back to the home data dir", () => {
    expect(resolveOpenCodeAuthFilePath({ XDG_DATA_HOME: "/xdg" }, "/home/me")).toBe(
      NodePath.resolve("/xdg", "opencode", "auth.json"),
    );
    expect(resolveOpenCodeAuthFilePath({}, "/home/me")).toBe(
      NodePath.resolve("/home/me", ".local", "share", "opencode", "auth.json"),
    );
  });
});

describe("readOpenCodeGoUsageLimits", () => {
  const httpOf = (
    handler: (request: { readonly url: string; readonly headers: Record<string, string> }) => {
      readonly body: unknown;
      readonly status?: number;
    },
    seen?: Array<string>,
  ) =>
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen?.push(`${request.headers.authorization ?? ""} ${request.url}`);
        const next = handler({ url: request.url, headers: request.headers });
        return HttpClientResponse.fromWeb(
          request,
          next.status === undefined
            ? Response.json(next.body)
            : Response.json(next.body, { status: next.status }),
        );
      }),
    );

  it.effect("sends the Go bearer and maps the windows", () =>
    Effect.gen(function* () {
      const { dataHome } = makeAuthFile(
        encodeJson({ "opencode-go": { type: "api", key: "sk-go" } }),
      );
      try {
        const seen: string[] = [];
        let observedUrl = "";
        const httpClient = httpOf((request) => {
          observedUrl = request.url;
          return { body: liveBody };
        }, seen);
        const limits = yield* readOpenCodeGoUsageLimits({
          httpClient,
          environment: { XDG_DATA_HOME: dataHome },
          checkedAt: CHECKED_AT,
        });
        expect(observedUrl).toBe(OPEN_CODE_GO_USAGE_URL);
        expect(seen).toEqual([`Bearer sk-go ${OPEN_CODE_GO_USAGE_URL}`]);
        expect(limits?.windows.map((window) => window.usedPercent)).toEqual([5, 63, 54]);
        expect(encodeJson(limits)).not.toContain("sk-go");
      } finally {
        removeAuthFile(dataHome);
      }
    }),
  );

  it.effect("degrades a refused request to probeFailed without leaking the body", () =>
    Effect.gen(function* () {
      const { dataHome } = makeAuthFile(encodeJson({ "opencode-go": { key: "sk-go" } }));
      try {
        const httpClient = httpOf(() => ({ status: 500, body: { error: "do-not-publish" } }));
        const limits = yield* readOpenCodeGoUsageLimits({
          httpClient,
          environment: { XDG_DATA_HOME: dataHome },
          checkedAt: CHECKED_AT,
        });
        expect(limits?.unavailable?.reason).toBe("probeFailed");
        expect(limits?.windows).toEqual([]);
        expect(encodeJson(limits)).not.toContain("do-not-publish");
      } finally {
        removeAuthFile(dataHome);
      }
    }),
  );

  it.effect("publishes nothing when no Go credential is stored", () =>
    Effect.gen(function* () {
      let requested = false;
      const httpClient = httpOf(() => {
        requested = true;
        return { body: liveBody };
      });
      const limits = yield* readOpenCodeGoUsageLimits({
        httpClient,
        environment: { XDG_DATA_HOME: NodePath.join(NodeOS.tmpdir(), "t3-opencode-go-missing") },
        checkedAt: CHECKED_AT,
      });
      expect(limits).toBeUndefined();
      expect(requested).toBe(false);
    }),
  );
});
