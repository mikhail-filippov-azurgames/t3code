// @effect-diagnostics nodeBuiltinImport:off - Fake process handles are EventEmitters.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  applyPiBonsaiPresetToConfig,
  buildPiInferenceServerArgs,
  detectPiBonsaiPreset,
  makePiInferenceServerManager,
  parsePiInferenceConfig,
  PI_BONSAI_MODEL_ID,
  savePiInferenceConfig,
  loadPiInferenceConfig,
  type PiInferenceConfig,
  type PiInferenceServerDependencies,
} from "./inferenceServer.ts";

const MODEL = "bonsai-2-27b";
const OTHER_MODEL = "qwen-3";
const profile = {
  model: MODEL,
  baseUrl: "http://127.0.0.1:8080/v1",
  executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
  modelPath: "C:\\Bonsai\\models\\bonsai.gguf",
};
const otherProfile = { ...profile, model: OTHER_MODEL };
const config: PiInferenceConfig = {
  baseUrl: profile.baseUrl,
  apiKey: "local",
  profiles: [profile],
};

class FakeChild extends NodeEvents.EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  alive = true;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (!this.alive) return true;
    this.alive = false;
    this.emit("close", 0, signal ?? null);
    return true;
  }
}

function makeFake(healthCallsBeforeReady: number): {
  readonly deps: PiInferenceServerDependencies;
  readonly children: ReadonlyArray<FakeChild>;
  readonly spawnArgs: Array<ReadonlyArray<string>>;
  readonly state: { servedModel: string; healthy: boolean; started: boolean };
  readonly healthCalls: () => number;
} {
  let healthCalls = 0;
  const children: Array<FakeChild> = [];
  const spawnArgs: Array<ReadonlyArray<string>> = [];
  const state = { servedModel: MODEL, healthy: true, started: false };
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      input instanceof URL ? input : typeof input === "string" ? input : input.url,
    );
    if (url.pathname === "/health") {
      healthCalls += 1;
      if (!state.started || !state.healthy || healthCalls < healthCallsBeforeReady) {
        return new Response("", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: state.servedModel }] }), { status: 200 });
  }) as typeof fetch;
  const deps: PiInferenceServerDependencies = {
    spawn: (_command, args) => {
      spawnArgs.push([...args]);
      const aliasIndex = args.indexOf("--alias");
      state.servedModel = aliasIndex >= 0 ? (args[aliasIndex + 1] ?? MODEL) : MODEL;
      state.healthy = true;
      state.started = true;
      const child = new FakeChild();
      child.on("close", () => {
        if (children.every((candidate) => !candidate.alive)) state.started = false;
      });
      children.push(child);
      return child as unknown as ReturnType<PiInferenceServerDependencies["spawn"]>;
    },
    isFile: async () => true,
    fetch: fetcher,
    now: () => 1,
    sleep: async () => undefined,
  };
  return {
    deps,
    children,
    spawnArgs,
    state,
    healthCalls: () => healthCalls,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
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
  const fake = makeFake(3);
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);

  await Promise.all([
    manager.ensureReady("a", `ft3-local/${MODEL}`),
    manager.ensureReady("a", MODEL),
  ]);

  assert.equal(fake.spawnArgs.length, 1);
  assert.isAtLeast(fake.healthCalls(), 3);

  await manager.ensureReady("a", MODEL);
  assert.equal(fake.spawnArgs.length, 1);
});

it("does not start anything when the model has no managed profile", async () => {
  const fake = makeFake(1);
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);
  await manager.ensureReady("a", "some-other-model");
  assert.equal(fake.spawnArgs.length, 0);
});

it("rejects a non-loopback endpoint instead of launching a remote server", async () => {
  const fake = makeFake(1);
  const remote: PiInferenceConfig = {
    ...config,
    profiles: [{ ...profile, baseUrl: "https://example.com/v1" }],
  };
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", remote);
  const failure = await failureOf(manager.ensureReady("a", MODEL));
  assert.instanceOf(failure, Error);
  assert.equal(fake.spawnArgs.length, 0);
});

it("rejects an invalid profile file", () => {
  assert.throws(() => parsePiInferenceConfig({ profiles: [{ model: "x" }] }));
});

it("refuses a second profile at an endpoint owned by another instance", async () => {
  const fake = makeFake(1);
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);
  manager.registerInstance("b", {
    ...config,
    profiles: [{ ...otherProfile }],
  });

  await manager.ensureReady("a", MODEL);
  const failure = await failureOf(manager.ensureReady("b", OTHER_MODEL));

  assert.instanceOf(failure, Error);
  assert.match(failure!.message, /different Pi model\/server profile|different server profile/);
  assert.equal(fake.spawnArgs.length, 1);
  assert.deepEqual(fake.children[0]!.killSignals, []);
});

it("switches the owned profile when the same instance selects another model", async () => {
  const fake = makeFake(1);
  const manager = makePiInferenceServerManager(fake.deps);
  const configWithBoth: PiInferenceConfig = { ...config, profiles: [profile, otherProfile] };
  manager.registerInstance("a", configWithBoth);

  await manager.ensureReady("a", MODEL);
  assert.equal(fake.spawnArgs.length, 1);
  await manager.ensureReady("a", OTHER_MODEL);

  assert.equal(fake.spawnArgs.length, 2);
  assert.equal(fake.children[0]!.killSignals.length, 1);
  const status = await manager.status("a", OTHER_MODEL);
  assert.equal(status.model, OTHER_MODEL);
  assert.isTrue(status.ready);
  assert.isTrue(status.owned);
});

it("shares one endpoint between instances and only stops the last claim", async () => {
  const fake = makeFake(1);
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);
  manager.registerInstance("b", config);

  await manager.ensureReady("a", MODEL);
  await manager.ensureReady("b", MODEL);
  assert.equal(fake.spawnArgs.length, 1);

  await manager.stop("a");
  assert.equal(fake.children[0]!.killSignals.length, 0);

  await manager.stop("b");
  assert.equal(fake.children[0]!.killSignals.length, 1);
  assert.equal(fake.spawnArgs.length, 1);
});

it("stops the owned server and reports the stopped phase", async () => {
  const fake = makeFake(1);
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);
  await manager.ensureReady("a", MODEL);

  const status = await manager.stop("a");
  assert.equal(status.phase, "stopped");
  assert.isFalse(status.ready);
  assert.equal(fake.children[0]!.killSignals.length, 1);
});

it("rejects an external endpoint that serves a different model", async () => {
  const fake = makeFake(1);
  fake.state.servedModel = OTHER_MODEL;
  fake.state.started = true;
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);

  const failure = await failureOf(manager.ensureReady("a", MODEL));
  assert.instanceOf(failure, Error);
  assert.match(failure!.message, /already serving a different model/);
  assert.equal(fake.spawnArgs.length, 0);
});

const bonsaiPreset = {
  executablePath: "C:\\root\\bin\\cuda\\llama-server.exe",
  modelPath: "C:\\root\\models\\bonsai2-gguf\\27B\\Ternary-Bonsai-2-27B-PQ2_0.gguf",
  baseUrl: "http://127.0.0.1:8080/v1",
  model: PI_BONSAI_MODEL_ID,
};

it("offers a Bonsai preset only when both host files exist", async () => {
  const files = new Set([bonsaiPreset.executablePath, bonsaiPreset.modelPath]);
  const preset = await detectPiBonsaiPreset({
    isFile: async (file) => files.has(file),
    environment: { BONSAI_DEMO_HOME: "C:\\root" } as NodeJS.ProcessEnv,
  });

  assert.deepEqual(preset, bonsaiPreset);
});

it("does not search a Bonsai root without an explicit path or env value", async () => {
  const checkedPaths: Array<string> = [];
  const preset = await detectPiBonsaiPreset({
    isFile: async (file) => {
      checkedPaths.push(file);
      return true;
    },
    environment: {},
  });

  assert.isNull(preset);
  assert.deepEqual(checkedPaths, []);
});

it("keeps an invalid selected folder from falling back to the configured root", async () => {
  const preset = await detectPiBonsaiPreset({
    rootPath: "C:\\selected",
    isFile: async (file) => file.startsWith("C:\\configured\\"),
    environment: { BONSAI_DEMO_HOME: "C:\\configured" } as NodeJS.ProcessEnv,
  });

  assert.isNull(preset);
});

it("replaces only the preset model and keeps other managed profiles", () => {
  const existing = { ...profile, model: "ft3-local/bonsai-2-27b" };
  const other = { ...profile, model: "ft3-local/other" };
  const next = applyPiBonsaiPresetToConfig(
    { ...config, profiles: [other, existing] },
    bonsaiPreset,
  );

  assert.deepEqual(next.profiles, [
    other,
    {
      model: "ft3-local/bonsai-2-27b",
      baseUrl: bonsaiPreset.baseUrl,
      executablePath: bonsaiPreset.executablePath,
      modelPath: bonsaiPreset.modelPath,
    },
  ]);
});

it("round-trips a saved inference config", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-config-"));
  const filePath = NodePath.join(root, "pi", "instance", "inference-profiles.json");
  try {
    await savePiInferenceConfig(filePath, config);
    const loaded = await loadPiInferenceConfig(filePath);
    assert.equal(loaded.baseUrl, config.baseUrl);
    assert.equal(loaded.apiKey, config.apiKey);
    assert.deepEqual(
      loaded.profiles.map((entry) => entry.model),
      [MODEL],
    );
    assert.equal(loaded.profiles[0]?.modelPath, profile.modelPath);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("serializes requests per endpoint through one slot", async () => {
  const fake = makeFake(1);
  const manager = makePiInferenceServerManager(fake.deps);
  const queue: Array<string> = [];
  const releaseFirst = await manager.acquireRequestSlot(profile.baseUrl);
  queue.push("first");

  const second = manager
    .acquireRequestSlot(profile.baseUrl, { onQueued: () => queue.push("queued") })
    .then((release) => {
      queue.push("second");
      return release;
    });

  assert.deepEqual(queue, ["first", "queued"]);
  releaseFirst();
  const releaseSecond = await second;
  releaseSecond();
  assert.deepEqual(queue, ["first", "queued", "second"]);
});
