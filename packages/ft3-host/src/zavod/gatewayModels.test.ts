import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  applyGatewayModels,
  fetchGatewayModels,
  filterModelFamily,
  readZavodGatewayConfig,
  type GatewayModelsList,
  type GatewayModelsResult,
} from "./gatewayModels.ts";

const KEY = "sk-fixture-gateway-key-0123456789";
const origin = "https://zavod-gateway.example";
const config = { origin, helperCommand: "/opt/zavod/zavod-key" };

interface HelperBehaviour {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
}

const fakeSpawner = (behaviour: HelperBehaviour = {}) => {
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
      launches.push(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: behaviour.hang
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(new TextEncoder().encode(behaviour.stdout ?? `${KEY}\n`)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches };
};

const fakeHttp = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, respond(request));
    }),
  );
  return { client, requests };
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const run = (input: {
  readonly helper?: HelperBehaviour;
  readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly hangRequest?: boolean;
}) => {
  const { spawner, launches } = fakeSpawner(input.helper);
  const { client, requests } = input.hangRequest
    ? {
        client: HttpClient.make(() => Effect.never),
        requests: [] as Array<HttpClientRequest.HttpClientRequest>,
      }
    : fakeHttp(input.respond ?? (() => json(200, { data: [{ id: "claude-opus-5" }] })));
  return fetchGatewayModels(config).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.map((result) => ({ result, launches, requests })),
  );
};

const assertNoKey = (result: GatewayModelsResult) =>
  assert.notInclude(JSON.stringify(result), KEY.slice(3, 20));

describe("fetchGatewayModels", () => {
  it.effect("returns the listed ids on 200 and sends the key only as a bearer header", () =>
    Effect.gen(function* () {
      const { result, launches, requests } = yield* run({
        respond: () => json(200, { data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }] }),
      });
      assert.deepStrictEqual(result, { kind: "list", ids: ["claude-opus-5", "claude-sonnet-5"] });
      assert.strictEqual(launches[0]?.command, config.helperCommand);
      assert.deepStrictEqual(launches[0]?.args, []);
      assert.notStrictEqual(launches[0]?.options.shell, true);
      assert.strictEqual(requests[0]?.url, `${origin}/v1/models`);
      assert.strictEqual(requests[0]?.headers.authorization, `Bearer ${KEY}`);
    }),
  );

  it.effect.each([
    ["403", () => json(403, { error: { code: "team_model_access_denied", key: KEY } })],
    ["401", () => json(401, { error: "invalid key" })],
    ["503 auth_unavailable", () => json(503, { error: { code: "auth_unavailable" } })],
    ["malformed JSON", () => new Response("{not json", { status: 200 })],
    ["empty data", () => json(200, { data: [] })],
    ["missing data", () => json(200, { models: ["claude-opus-5"] })],
  ] as const)("is unavailable on %s", ([, response]) =>
    Effect.gen(function* () {
      const { result } = yield* run({ respond: response });
      assert.strictEqual(result.kind, "unavailable");
      assertNoKey(result);
    }),
  );

  it.effect("is unavailable when the request times out", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(run({ hangRequest: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("16 seconds");
      const { result } = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result, { kind: "unavailable", reason: "request timed out" });
    }),
  );

  it.effect("is unavailable when the helper hangs, without a request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(run({ helper: { hang: true } }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("11 seconds");
      const { result, requests } = yield* Fiber.join(fiber);
      assert.strictEqual(result.kind, "unavailable");
      assert.strictEqual(requests.length, 0);
    }),
  );

  it.effect.each([
    ["exits non-zero", { exitCode: 1 }],
    ["prints nothing", { stdout: "  \n" }],
  ] as const)("is unavailable without a request when the helper %s", ([, helper]) =>
    Effect.gen(function* () {
      const { result, requests } = yield* run({ helper });
      assert.strictEqual(result.kind, "unavailable");
      assert.strictEqual(requests.length, 0);
      assertNoKey(result);
    }),
  );

  it.effect("keeps the key out of a failing transport error", () =>
    Effect.gen(function* () {
      const { spawner } = fakeSpawner();
      const client = HttpClient.make((request) =>
        Effect.die(new Error(`boom ${request.headers.authorization}`)),
      );
      const result = yield* fetchGatewayModels(config).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      assert.strictEqual(result.kind, "unavailable");
      assertNoKey(result);
    }),
  );
});

const fileLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const withHome = <A, E>(
  files: Record<string, string>,
  use: (home: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "ft3-zavod-models-" });
      for (const [name, text] of Object.entries(files)) {
        yield* fs.writeFileString(path.join(home, name), text);
      }
      return yield* use(home);
    }),
  ).pipe(Effect.provide(fileLayer));

describe("readZavodGatewayConfig", () => {
  // A bare `zavod-key` passes the helper check on every platform, unlike an absolute path.
  const userHome = "/home/user";
  const helper = "zavod-key";

  it.effect("reads a Claude gateway home with a quoted helper path", () =>
    withHome(
      {
        "settings.json": JSON.stringify({
          env: { ANTHROPIC_BASE_URL: `${origin}/anthropic` },
          apiKeyHelper: JSON.stringify(helper),
        }),
      },
      (home) =>
        Effect.map(
          readZavodGatewayConfig({ family: "claude", homePath: home, homeDirectory: userHome }),
          (result) => assert.deepStrictEqual(result, { origin, helperCommand: helper }),
        ),
    ),
  );

  it.effect("accepts zavod-key under the home .zavod directory", () =>
    withHome(
      {
        "settings.json": JSON.stringify({
          env: { ANTHROPIC_BASE_URL: origin },
          apiKeyHelper: '"~/.zavod/bin/ZAVOD-KEY.exe"',
        }),
      },
      (home) =>
        Effect.map(
          readZavodGatewayConfig({ family: "claude", homePath: home, homeDirectory: userHome }),
          (result) =>
            assert.match(result?.helperCommand ?? "", /[\\/]\.zavod[\\/]bin[\\/]ZAVOD-KEY\.exe$/),
        ),
    ),
  );

  it.effect("reads the active Codex provider with an auth command", () =>
    withHome(
      {
        "config.toml": [
          'model_provider = "zavod"',
          "[model_providers.zavod]",
          `base_url = "${origin}/v1"`,
          "[model_providers.zavod.auth]",
          `command = '${helper}'`,
        ].join("\n"),
      },
      (home) =>
        Effect.map(
          readZavodGatewayConfig({ family: "codex", homePath: home, homeDirectory: userHome }),
          (result) => assert.deepStrictEqual(result, { origin, helperCommand: helper }),
        ),
    ),
  );

  it.effect.each([
    ["an empty Claude home", "claude", {}],
    [
      "a Claude home without a helper",
      "claude",
      { "settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin } }) },
    ],
    [
      "a Claude home without a gateway",
      "claude",
      { "settings.json": JSON.stringify({ apiKeyHelper: helper }) },
    ],
    [
      "a Claude helper given as shell text",
      "claude",
      {
        "settings.json": JSON.stringify({
          env: { ANTHROPIC_BASE_URL: origin },
          apiKeyHelper: "cat key | tr -d x",
        }),
      },
    ],
    ["an empty Codex home", "codex", {}],
    ["a Codex home on the default provider", "codex", { "config.toml": 'model = "gpt-6-luna"' }],
    [
      "a Codex provider without auth.command",
      "codex",
      {
        "config.toml": `model_provider = "zavod"\n[model_providers.zavod]\nbase_url = "${origin}/v1"`,
      },
    ],
    ["an unreadable Codex TOML", "codex", { "config.toml": "model_provider = " }],
    [
      "a Claude proxy with its own key helper",
      "claude",
      {
        "settings.json": JSON.stringify({
          env: { ANTHROPIC_BASE_URL: origin },
          apiKeyHelper: "/opt/tools/company-key.exe",
        }),
      },
    ],
    [
      "a Codex proxy with its own key helper",
      "codex",
      {
        "config.toml": `model_provider = "corp"\n[model_providers.corp]\nbase_url = "${origin}/v1"\n[model_providers.corp.auth]\ncommand = '/opt/tools/company-key'`,
      },
    ],
  ] as const)("returns null for %s", ([, family, files]) =>
    withHome(files, (home) =>
      Effect.map(
        readZavodGatewayConfig({ family, homePath: home, homeDirectory: userHome }),
        (result) => assert.isNull(result),
      ),
    ),
  );
});

const model = (slug: string, extra: { isCustom?: boolean; isDefault?: boolean } = {}) => ({
  slug,
  isCustom: extra.isCustom ?? false,
  ...(extra.isDefault === undefined ? {} : { isDefault: extra.isDefault }),
});
const slugs = (models: ReadonlyArray<{ readonly slug: string }>) => models.map((m) => m.slug);
const list = (...ids: Array<string>): GatewayModelsList => ({ kind: "list", ids });
const unavailable: GatewayModelsResult = { kind: "unavailable", reason: "status 503" };

describe("applyGatewayModels", () => {
  const catalog = [
    model("claude-opus-5-5", { isDefault: true }),
    model("claude-sonnet-5-5"),
    model("claude-haiku-5-5"),
    model("claude-fable-5-2"),
    model("my-tuned", { isCustom: true }),
  ];
  const served = list("claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-luna");

  it("drops catalog models the key cannot use and keeps custom ones", () => {
    assert.deepStrictEqual(slugs(applyGatewayModels(catalog, served, undefined)), [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "my-tuned",
    ]);
  });

  it("leaves the catalog unchanged when unavailable without a last good list", () => {
    assert.strictEqual(applyGatewayModels(catalog, unavailable, undefined), catalog);
  });

  it("applies the last good list when unavailable", () => {
    assert.deepStrictEqual(slugs(applyGatewayModels(catalog, unavailable, served)), [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "my-tuned",
    ]);
  });

  it("does not leave a removed default model marked default", () => {
    const result = applyGatewayModels(catalog, list("claude-sonnet-5-5"), undefined);
    assert.deepStrictEqual(slugs(result), ["claude-sonnet-5-5", "my-tuned"]);
    assert.isFalse(result.some((m) => "isDefault" in m && m.isDefault === true));
  });

  it("treats a list with no catalog match as unavailable", () => {
    const prefixed = list("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5");
    assert.strictEqual(applyGatewayModels(catalog, prefixed, undefined), catalog);
    assert.deepStrictEqual(slugs(applyGatewayModels(catalog, prefixed, served)), [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "my-tuned",
    ]);
  });
});

describe("filterModelFamily", () => {
  const mixed = [
    model("claude-Opus-5"),
    model("claude-sonnet-4"),
    model("claude-3-5-haiku"),
    model("GPT-6-Luna"),
    model("gpt-6.1-terra"),
    model("codex-mini-latest"),
    model("my-claude-proxy", { isCustom: true }),
    model("local-llama", { isCustom: true }),
  ];

  it("keeps only gpt and codex models for Codex, ignoring case", () => {
    assert.deepStrictEqual(slugs(filterModelFamily(mixed, "codex")), [
      "GPT-6-Luna",
      "gpt-6.1-terra",
      "codex-mini-latest",
      "my-claude-proxy",
      "local-llama",
    ]);
  });

  it("keeps only claude models for Claude, ignoring case", () => {
    assert.deepStrictEqual(slugs(filterModelFamily(mixed, "claude")), [
      "claude-Opus-5",
      "claude-sonnet-4",
      "claude-3-5-haiku",
      "my-claude-proxy",
      "local-llama",
    ]);
  });

  it("still filters by family when the gateway is unavailable", () => {
    const result = applyGatewayModels(filterModelFamily(mixed, "codex"), unavailable, undefined);
    assert.deepStrictEqual(slugs(result), [
      "GPT-6-Luna",
      "gpt-6.1-terra",
      "codex-mini-latest",
      "my-claude-proxy",
      "local-llama",
    ]);
  });
});
