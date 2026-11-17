import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { withZavodGatewayModels } from "./drivers.ts";
import type { ModelFamily } from "./gatewayModels.ts";

const origin = "https://zavod-gateway.example";
// A bare `zavod-key` passes the helper check on every platform, unlike an absolute path.
const userHome = "/home/user";
const helper = "zavod-key";

const claudeHome = {
  "settings.json": JSON.stringify({
    env: { ANTHROPIC_BASE_URL: origin },
    apiKeyHelper: JSON.stringify(helper),
  }),
};
const codexHome = {
  "config.toml": [
    'model_provider = "zavod"',
    "[model_providers.zavod]",
    `base_url = "${origin}/v1"`,
    "[model_providers.zavod.auth]",
    `command = '${helper}'`,
  ].join("\n"),
};

const model = (slug: string, isCustom = false) => ({
  slug,
  name: slug,
  isCustom,
  capabilities: null,
});
const slugs = (snapshot: { readonly models: ReadonlyArray<{ readonly slug: string }> }) =>
  snapshot.models.map((entry) => entry.slug);

const claudeCatalog = [
  model("claude-opus-5-5"),
  model("claude-sonnet-5-5"),
  model("claude-haiku-5-5"),
  model("claude-fable-5-2"),
  model("my-tuned", true),
];
const mixedCatalog = [
  model("claude-opus-5"),
  model("claude-sonnet-4"),
  model("claude-3-5-haiku"),
  model("gpt-6-luna"),
  model("gpt-6.1-terra"),
  model("codex-mini"),
];

const makeUpstream = Effect.fn("test.makeUpstream")(function* (
  models: ReadonlyArray<ReturnType<typeof model>>,
) {
  let current = { models } as unknown as ServerProvider;
  const changes = yield* PubSub.unbounded<ServerProvider>();
  const counters = { refreshes: 0 };
  const snapshot: ManagedServerProvider = {
    resolveMaintenance: () => Effect.die("unused"),
    getSnapshot: Effect.sync(() => current),
    refresh: Effect.sync(() => {
      counters.refreshes += 1;
      return current;
    }),
    streamChanges: Stream.fromPubSub(changes),
    applyUsageLimits: () => Effect.void,
  };
  const instance = {
    instanceId: "claudeZavod",
    snapshot,
    snapshotForCwd: () => Effect.sync(() => ({ ...current, workspaceModels: current.models })),
  } as unknown as ProviderInstance;
  const publish = (next: ReadonlyArray<ReturnType<typeof model>>) =>
    Effect.suspend(() => {
      current = { models: next } as unknown as ServerProvider;
      return PubSub.publish(changes, current);
    });
  return { instance, publish, counters };
});

const makeNetwork = (responses: Array<() => Response>) => {
  const counters = { helper: 0, requests: 0 };
  const spawner = ChildProcessSpawner.make(() =>
    Effect.sync(() => {
      counters.helper += 1;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(new TextEncoder().encode("fixture-key\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const respond = responses[Math.min(counters.requests, responses.length - 1)]!;
      counters.requests += 1;
      return HttpClientResponse.fromWeb(request, respond());
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, client),
  );
  return { counters, layer };
};

const served =
  (...ids: Array<string>) =>
  () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
const unavailable = () => new Response('{"error":"auth_unavailable"}', { status: 503 });

const decorate = <A, E>(
  input: {
    readonly family: ModelFamily;
    readonly files: Record<string, string>;
    readonly catalog: ReadonlyArray<ReturnType<typeof model>>;
    readonly responses: Array<() => Response>;
  },
  use: (context: {
    readonly upstream: Effect.Success<ReturnType<typeof makeUpstream>>;
    readonly decorated: ProviderInstance;
    readonly network: ReturnType<typeof makeNetwork>["counters"];
  }) => Effect.Effect<A, E>,
) => {
  const network = makeNetwork(input.responses);
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "ft3-zavod-drivers-" });
      for (const [name, text] of Object.entries(input.files)) {
        yield* fs.writeFileString(path.join(home, name), text);
      }
      const upstream = yield* makeUpstream(input.catalog);
      const decorated = yield* withZavodGatewayModels(upstream.instance, {
        family: input.family,
        homePath: home,
        homeDirectory: userHome,
      });
      return yield* use({ upstream, decorated, network: network.counters });
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, network.layer)));
};

// The first check runs in a forked fiber; yield until it has published.
const settle = Effect.gen(function* () {
  for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
});

describe("withZavodGatewayModels", () => {
  it.effect("hides models the key cannot use after the first check", () =>
    decorate(
      {
        family: "claude",
        files: claudeHome,
        catalog: claudeCatalog,
        responses: [served("claude-opus-5-5", "claude-sonnet-5-5")],
      },
      ({ decorated, network }) =>
        Effect.gen(function* () {
          yield* settle;
          assert.deepStrictEqual(slugs(yield* decorated.snapshot.getSnapshot), [
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "my-tuned",
          ]);
          assert.strictEqual(network.requests, 1);
        }),
    ),
  );

  it.effect("keeps only gpt and codex models for Codex on the gateway", () =>
    decorate(
      {
        family: "codex",
        files: codexHome,
        catalog: mixedCatalog,
        responses: [served(...mixedCatalog.map((entry) => entry.slug))],
      },
      ({ decorated }) =>
        Effect.gen(function* () {
          yield* settle;
          assert.deepStrictEqual(slugs(yield* decorated.snapshot.refresh), [
            "gpt-6-luna",
            "gpt-6.1-terra",
            "codex-mini",
          ]);
        }),
    ),
  );

  it.effect("passes a home off the gateway through untouched without running the helper", () =>
    decorate(
      {
        family: "claude",
        files: { "settings.json": JSON.stringify({ model: "opus" }) },
        catalog: claudeCatalog,
        responses: [served("claude-opus-5-5")],
      },
      ({ upstream, decorated, network }) =>
        Effect.gen(function* () {
          yield* settle;
          assert.strictEqual(decorated, upstream.instance);
          yield* decorated.snapshot.refresh;
          assert.deepStrictEqual(network, { helper: 0, requests: 0 });
        }),
    ),
  );

  it.effect("keeps the last good list when a refresh hits 503", () =>
    decorate(
      {
        family: "claude",
        files: claudeHome,
        catalog: claudeCatalog,
        responses: [served("claude-opus-5-5", "claude-sonnet-5-5"), unavailable],
      },
      ({ decorated, network, upstream }) =>
        Effect.gen(function* () {
          yield* settle;
          const refreshed = yield* decorated.snapshot.refresh;
          assert.strictEqual(network.requests, 2);
          assert.strictEqual(upstream.counters.refreshes, 1);
          assert.deepStrictEqual(slugs(refreshed), [
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "my-tuned",
          ]);
        }),
    ),
  );

  it.effect("leaves the catalog whole when the gateway was never reachable", () =>
    decorate(
      { family: "claude", files: claudeHome, catalog: claudeCatalog, responses: [unavailable] },
      ({ decorated }) =>
        Effect.gen(function* () {
          yield* settle;
          assert.deepStrictEqual(
            slugs(yield* decorated.snapshot.getSnapshot),
            claudeCatalog.map((entry) => entry.slug),
          );
        }),
    ),
  );

  it.effect("narrows streamed and per-directory snapshots without touching the network", () =>
    decorate(
      {
        family: "claude",
        files: claudeHome,
        catalog: claudeCatalog,
        responses: [served("claude-opus-5-5")],
      },
      ({ decorated, network, upstream }) =>
        Effect.gen(function* () {
          yield* settle;
          const collected = yield* decorated.snapshot.streamChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* settle;
          yield* upstream.publish([...claudeCatalog, model("gpt-6-luna")]);
          const [streamed] = yield* Fiber.join(collected);
          assert.deepStrictEqual(slugs(streamed!), ["claude-opus-5-5", "my-tuned"]);
          const scoped = yield* decorated.snapshotForCwd!("/repo");
          assert.deepStrictEqual(slugs(scoped), ["claude-opus-5-5", "my-tuned"]);
          assert.deepStrictEqual(
            scoped.workspaceModels?.map((entry) => entry.slug),
            ["claude-opus-5-5", "my-tuned"],
          );
          assert.deepStrictEqual(network, { helper: 1, requests: 1 });
        }),
    ),
  );
});
