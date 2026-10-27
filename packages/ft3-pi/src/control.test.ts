// @effect-diagnostics nodeBuiltinImport:off - Fake process handles are EventEmitters.
import * as NodeEvents from "node:events";

import { assert, it } from "@effect/vitest";

import { makePiInferenceControl } from "./control.ts";
import {
  makePiInferenceServerManager,
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
  alive = true;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (!this.alive) return true;
    this.alive = false;
    this.emit("close", 0, signal ?? null);
    return true;
  }
}

function makeFake() {
  const children: Array<FakeChild> = [];
  const spawnArgs: Array<ReadonlyArray<string>> = [];
  const state = { started: false };
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      input instanceof URL ? input : typeof input === "string" ? input : input.url,
    );
    if (url.pathname === "/health") {
      return state.started
        ? new Response("ok", { status: 200 })
        : new Response("", { status: 503 });
    }
    if (!state.started) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ data: [{ id: MODEL }] }), { status: 200 });
  }) as typeof fetch;
  const deps: PiInferenceServerDependencies = {
    spawn: (_command, args) => {
      spawnArgs.push([...args]);
      state.started = true;
      const child = new FakeChild();
      child.on("close", () => {
        state.started = false;
      });
      children.push(child);
      return child as unknown as ReturnType<PiInferenceServerDependencies["spawn"]>;
    },
    isFile: async () => true,
    fetch: fetcher,
    now: () => 1,
    sleep: async () => undefined,
  };
  return { deps, children, spawnArgs, state };
}

function makeControl(instanceId: string, options: { readonly externalReady?: boolean } = {}) {
  const fake = makeFake();
  if (options.externalReady === true) fake.state.started = true;
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance(instanceId, config);
  return { fake, manager, control: makePiInferenceControl({ manager }) };
}

it("reports a stopped endpoint with a startable profile", async () => {
  const { fake, control } = makeControl("a");

  const status = await control.status("a", MODEL);

  assert.equal(status.phase, "stopped");
  assert.isFalse(status.ready);
  assert.isFalse(status.owned);
  assert.isTrue(status.canStart);
  assert.equal(fake.spawnArgs.length, 0);
});

it("starts the managed profile and reports it as owned", async () => {
  const { fake, control } = makeControl("a");

  const status = await control.start("a", MODEL);

  assert.equal(fake.spawnArgs.length, 1);
  assert.equal(status.phase, "ready");
  assert.isTrue(status.ready);
  assert.isTrue(status.owned);
  assert.deepEqual(status.modelIds, [MODEL]);
});

it("stops only the process captured by the fake runner", async () => {
  const { fake, control } = makeControl("a");

  await control.start("a", MODEL);
  const status = await control.stop("a", MODEL);

  assert.equal(status.phase, "stopped");
  assert.isFalse(status.owned);
  assert.equal(fake.children[0]!.killSignals.length, 1);
});

it("reports a failed start when the selected model has no managed profile", async () => {
  const { fake, control } = makeControl("a");

  const status = await control.start("a", "qwen-3");

  assert.equal(status.phase, "failed");
  assert.match(status.error ?? "", /no managed inference profile/);
  assert.isFalse(status.canStart);
  assert.equal(fake.spawnArgs.length, 0);
});

it("does not offer start when an external server is already ready", async () => {
  const { fake, control } = makeControl("a", { externalReady: true });

  const status = await control.status("a", MODEL);

  assert.equal(status.phase, "ready");
  assert.isTrue(status.ready);
  assert.isFalse(status.owned);
  assert.isFalse(status.canStart);
  assert.equal(fake.spawnArgs.length, 0);
});

it("applies a detected preset to the registered config file and re-registers it", async () => {
  const fake = makeFake();
  const manager = makePiInferenceServerManager(fake.deps);
  const configPath = "C:\\state\\pi\\a\\inference-profiles.json";
  manager.registerInstance("a", config, configPath);
  const preset = {
    executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
    modelPath: "C:\\Bonsai\\models\\bonsai2-27b.gguf",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: MODEL,
  };
  const writes: Array<{ readonly path: string; readonly config: PiInferenceConfig }> = [];
  const control = makePiInferenceControl({
    manager,
    detectPreset: async () => preset,
    readConfig: async () => config,
    writeConfig: async (path, next) => {
      writes.push({ path, config: next });
    },
  });

  const applied = await control.applyPreset("a");

  assert.deepEqual(applied, preset);
  assert.equal(writes[0]?.path, configPath);
  assert.deepEqual(writes[0]?.config.profiles.at(-1), {
    model: `ft3-local/${MODEL}`,
    baseUrl: preset.baseUrl,
    executablePath: preset.executablePath,
    modelPath: preset.modelPath,
  });
  assert.deepEqual(manager.registeredConfig("a"), writes[0]?.config);
});

it("does not write a preset that was not detected", async () => {
  const fake = makeFake();
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config, "C:\\state\\pi\\a\\inference-profiles.json");
  let writes = 0;
  const control = makePiInferenceControl({
    manager,
    detectPreset: async () => null,
    writeConfig: async () => {
      writes += 1;
    },
  });

  assert.isNull(await control.applyPreset("a", "C:\\missing"));
  assert.equal(writes, 0);
});

it("reports a missing config path instead of guessing one", async () => {
  const fake = makeFake();
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config);
  const control = makePiInferenceControl({
    manager,
    detectPreset: async () => ({
      executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
      modelPath: "C:\\Bonsai\\models\\bonsai2-27b.gguf",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: MODEL,
    }),
  });

  let failure: unknown;
  try {
    await control.applyPreset("a");
  } catch (cause) {
    failure = cause;
  }
  assert.match(failure instanceof Error ? failure.message : "", /config path.*not registered/);
});

it("reports an unregistered instance instead of throwing", async () => {
  const { fake, control } = makeControl("a");

  const status = await control.status("missing", MODEL);

  assert.equal(status.phase, "failed");
  assert.match(status.error ?? "", /not registered/);
  assert.equal(fake.spawnArgs.length, 0);
});

it("returns launch defaults for a stored profile with unset tuning fields", () => {
  const { control } = makeControl("a");

  const settings = control.profile("a", `ft3-local/${MODEL}`);

  assert.equal(settings.model, `ft3-local/${MODEL}`);
  assert.equal(settings.baseUrl, profile.baseUrl);
  assert.equal(settings.contextSize, 81_920);
  assert.equal(settings.parallel, 1);
  assert.isTrue(settings.flashAttention);
});

it("saves one model's launch settings into the registered profile file", async () => {
  const fake = makeFake();
  const manager = makePiInferenceServerManager(fake.deps);
  const configPath = "C:\\state\\pi\\a\\inference-profiles.json";
  manager.registerInstance("a", config, configPath);
  const writes: Array<PiInferenceConfig> = [];
  const control = makePiInferenceControl({
    manager,
    readConfig: async () => config,
    writeConfig: async (_path, next) => {
      writes.push(next);
    },
  });

  const saved = await control.saveProfile("a", {
    model: `ft3-local/${MODEL}`,
    baseUrl: "http://127.0.0.1:8081/v1",
    executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
    modelPath: "C:\\Bonsai\\models\\bonsai-8b.gguf",
    gpuLayers: 99,
    contextSize: 16_384,
    parallel: 2,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    flashAttention: true,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    jinja: true,
    reasoning: true,
    reasoningEffort: "low",
  });

  assert.equal(saved.contextSize, 16_384);
  assert.equal(writes[0]?.profiles.length, 1);
  const written = writes[0]!.profiles[0]!;
  assert.equal(written.model, `ft3-local/${MODEL}`);
  assert.equal(written.baseUrl, "http://127.0.0.1:8081/v1");
  assert.equal(written.parallel, 2);
  assert.equal(written.cacheTypeK, "q8_0");
  assert.deepEqual(manager.registeredConfig("a"), writes[0]);
});

it("rejects a non-loopback endpoint before writing the profile file", async () => {
  const fake = makeFake();
  const manager = makePiInferenceServerManager(fake.deps);
  manager.registerInstance("a", config, "C:\\state\\pi\\a\\inference-profiles.json");
  let writes = 0;
  const control = makePiInferenceControl({
    manager,
    readConfig: async () => config,
    writeConfig: async () => {
      writes += 1;
    },
  });

  let failure: unknown;
  try {
    await control.saveProfile("a", {
      model: `ft3-local/${MODEL}`,
      baseUrl: "http://example.com/v1",
      executablePath: profile.executablePath,
      modelPath: profile.modelPath,
      gpuLayers: 48,
      contextSize: 81_920,
      parallel: 1,
      temperature: 1,
      topP: 0.95,
      topK: 20,
      minP: 0.05,
      flashAttention: true,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      jinja: true,
      reasoning: true,
      reasoningEffort: "medium",
    });
  } catch (cause) {
    failure = cause;
  }
  assert.match(failure instanceof Error ? failure.message : "", /loopback/);
  assert.equal(writes, 0);
});
