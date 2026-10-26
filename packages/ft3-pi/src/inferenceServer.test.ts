// @effect-diagnostics nodeBuiltinImport:off - Fake process handles are EventEmitters.
import * as NodeEvents from "node:events";

import { assert, it } from "@effect/vitest";

import {
  buildPiInferenceServerArgs,
  makePiInferenceServerManager,
  parsePiInferenceConfig,
  type PiInferenceConfig,
  type PiInferenceServerDependencies,
} from "./inferenceServer.ts";

const MODEL = "bonsai-2-27b";
const profile = {
  model: MODEL,
  baseUrl: "http://127.0.0.1:8080/v1",
  executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
  modelPath: "C:\\Bonsai\\models\\bonsai.gguf",
};
const config: PiInferenceConfig = {
  baseUrl: profile.baseUrl,
  apiKey: "local",
  profiles: [profile],
};

class FakeChild extends NodeEvents.EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.emit("close", 0, signal ?? null);
    return true;
  }
}

function dependencies(healthCallsBeforeReady: number): PiInferenceServerDependencies & {
  readonly spawnArgs: Array<ReadonlyArray<string>>;
  readonly healthCalls: () => number;
} {
  let healthCalls = 0;
  const children: Array<FakeChild> = [];
  const spawnArgs: Array<ReadonlyArray<string>> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      input instanceof URL ? input : typeof input === "string" ? input : input.url,
    );
    if (url.pathname === "/health") {
      healthCalls += 1;
      if (healthCalls < healthCallsBeforeReady) return new Response("", { status: 503 });
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: MODEL }] }), { status: 200 });
  }) as typeof fetch;
  return {
    spawnArgs,
    healthCalls: () => healthCalls,
    spawn: (_command: string, args: ReadonlyArray<string>) => {
      spawnArgs.push([...args]);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<PiInferenceServerDependencies["spawn"]>;
    },
    isFile: async () => true,
    fetch: fetcher,
    now: () => 1,
    sleep: async () => undefined,
  };
}

it("builds the fixed llama-server command line", () => {
  const args = buildPiInferenceServerArgs(profile);
  assert.deepEqual(args.slice(0, 2), ["-m", "C:\\Bonsai\\models\\bonsai.gguf"]);
  assert.includeMembers(
    [...args],
    ["--alias", MODEL, "--host", "127.0.0.1", "--port", "8080", "--jinja"],
  );
});

it("starts one process and waits for readiness before the turn", async () => {
  const deps = dependencies(3);
  const manager = makePiInferenceServerManager(config, deps);

  await Promise.all([manager.ensureReady(`ft3-local/${MODEL}`), manager.ensureReady(MODEL)]);

  assert.equal(deps.spawnArgs.length, 1);
  assert.isAtLeast(deps.healthCalls(), 3);

  await manager.ensureReady(MODEL);
  assert.equal(deps.spawnArgs.length, 1);
});

it("does not start anything when the model has no managed profile", async () => {
  const deps = dependencies(1);
  const manager = makePiInferenceServerManager(config, deps);
  await manager.ensureReady("some-other-model");
  assert.equal(deps.spawnArgs.length, 0);
});

it("rejects a non-loopback endpoint instead of launching a remote server", async () => {
  const deps = dependencies(1);
  const remote: PiInferenceConfig = {
    ...config,
    profiles: [{ ...profile, baseUrl: "https://example.com/v1" }],
  };
  const manager = makePiInferenceServerManager(remote, deps);
  let failure: unknown;
  try {
    await manager.ensureReady(MODEL);
  } catch (cause) {
    failure = cause;
  }
  assert.instanceOf(failure, Error);
  assert.equal(deps.spawnArgs.length, 0);
});

it("rejects an invalid profile file", () => {
  assert.throws(() => parsePiInferenceConfig({ profiles: [{ model: "x" }] }));
});
