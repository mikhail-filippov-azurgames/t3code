// @effect-diagnostics nodeBuiltinImport:off - Tests need a disposable host filesystem fixture for the path detector.
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type PiSettings as PiSettingsType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";

import {
  buildPiInferenceServerArgs,
  detectPiBonsaiPreset,
  makePiInferenceServerManager,
  makePiInferenceActivity,
  parsePiLocalEndpoint,
  piInferenceSettingsForModel,
  PI_BONSAI_MODEL_ID,
  probePiInferenceEndpoint,
  sanitizePiBaseUrlForDisplay,
  type PiInferenceServerDependencies,
} from "./piInferenceServer.ts";

const instanceId = ProviderInstanceId.make("pi-default");
const secondInstanceId = ProviderInstanceId.make("pi-secondary");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const decodePiSettings = Schema.decodeSync(PiSettings);
type FetchInput = Parameters<typeof fetch>[0];
const settings: PiSettingsType = {
  enabled: true,
  binaryPath: "pi",
  baseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "",
  model: PI_BONSAI_MODEL_ID,
  inferenceServerExecutablePath: "C:\\Bonsai\\bin\\llama-server.exe",
  inferenceServerModelPath: "C:\\Bonsai\\models\\bonsai.gguf",
  inferenceServerProfiles: [],
  inferenceServerAutoStart: false,
  inferenceServerGpuLayers: 48,
  inferenceServerContextSize: 81920,
  inferenceServerParallel: 1,
  inferenceServerTemperature: 1,
  inferenceServerTopP: 0.95,
  inferenceServerTopK: 20,
  inferenceServerMinP: 0.05,
  inferenceServerFlashAttention: true,
  inferenceServerCacheTypeK: "q4_0",
  inferenceServerCacheTypeV: "q4_0",
  inferenceServerJinja: true,
  inferenceServerReasoning: true,
  inferenceServerReasoningEffort: "medium",
  customModels: [],
};

async function makeBonsaiRoot(): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-bonsai-demo-"));
}

async function writeBonsaiFiles(rootPath: string) {
  const executablePath = NodePath.join(rootPath, "bin", "cuda", "llama-server.exe");
  const modelPath = NodePath.join(
    rootPath,
    "models",
    "bonsai2-gguf",
    "27B",
    "Ternary-Bonsai-2-27B-PQ2_0.gguf",
  );
  await NodeFSP.mkdir(NodePath.dirname(executablePath), { recursive: true });
  await NodeFSP.mkdir(NodePath.dirname(modelPath), { recursive: true });
  await NodeFSP.writeFile(executablePath, "fixture executable");
  await NodeFSP.writeFile(modelPath, "fixture model");
  return { executablePath, modelPath };
}

class FakeChild extends NodeEvents.EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.emit("close", 0, signal);
    return true;
  }
}

function requestUrl(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function successfulFetch(url: FetchInput): Promise<Response> {
  const target = requestUrl(url);
  return Promise.resolve(
    target.pathname === "/health"
      ? new Response("ok", { status: 200 })
      : new Response(JSON.stringify({ data: [{ id: PI_BONSAI_MODEL_ID }] }), { status: 200 }),
  );
}

function dependencies(
  overrides: Partial<PiInferenceServerDependencies> = {},
): PiInferenceServerDependencies & {
  readonly children: Array<FakeChild>;
  readonly spawnArgs: Array<ReadonlyArray<string>>;
} {
  const children: Array<FakeChild> = [];
  const spawnArgs: Array<ReadonlyArray<string>> = [];
  return {
    children,
    spawnArgs,
    spawn: (_command, args) => {
      spawnArgs.push([...args]);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<PiInferenceServerDependencies["spawn"]>;
    },
    isFile: async () => true,
    fetch: successfulFetch,
    now: Date.now,
    sleep: async () => undefined,
    ...overrides,
  };
}

function activity(
  threadId: ThreadId,
  messages: Array<string>,
  source: "manual" | "automatic" = "manual",
) {
  return makePiInferenceActivity({
    instanceId,
    threadId,
    source,
    emit: async (message) => {
      messages.push(message);
    },
  })!;
}

describe("Pi managed inference server", () => {
  it("decodes backward-compatible Pi defaults for managed launcher settings", () => {
    const defaults = decodePiSettings({});
    NodeAssert.equal(defaults.inferenceServerGpuLayers, 48);
    NodeAssert.equal(defaults.inferenceServerContextSize, 81920);
    NodeAssert.equal(defaults.inferenceServerParallel, 1);
    NodeAssert.equal(defaults.inferenceServerTemperature, 1);
    NodeAssert.equal(defaults.inferenceServerTopP, 0.95);
    NodeAssert.equal(defaults.inferenceServerTopK, 20);
    NodeAssert.equal(defaults.inferenceServerMinP, 0.05);
    NodeAssert.equal(defaults.inferenceServerCacheTypeK, "q4_0");
    NodeAssert.equal(defaults.inferenceServerCacheTypeV, "q4_0");
    NodeAssert.equal(defaults.inferenceServerReasoningEffort, "medium");
  });
  it("accepts only loopback HTTP endpoints and requires real health and model IDs", async () => {
    NodeAssert.equal(parsePiLocalEndpoint("https://127.0.0.1:8080/v1"), undefined);
    NodeAssert.equal(parsePiLocalEndpoint("http://example.com:8080/v1"), undefined);

    const malformed = await probePiInferenceEndpoint(
      { baseUrl: settings.baseUrl, apiKey: "" },
      async (input) => {
        const url = requestUrl(input);
        return url.pathname === "/health"
          ? new Response("ok", { status: 200 })
          : new Response(JSON.stringify({ data: [{ name: "no-id" }] }), { status: 200 });
      },
    );
    NodeAssert.equal(malformed.ready, false);
    NodeAssert.match(malformed.reason, /no parseable model IDs/);
  });

  it("does not treat a 404 health endpoint as ready", async () => {
    const probe = await probePiInferenceEndpoint(
      { baseUrl: settings.baseUrl, apiKey: "" },
      async () => new Response("not an OpenAI-compatible server", { status: 404 }),
    );

    NodeAssert.equal(probe.ready, false);
    if (!probe.ready) NodeAssert.match(probe.reason, /HTTP \/health returned 404/);
  });

  it("shows only the endpoint origin in status and diagnostics", async () => {
    const secretSettings = {
      ...settings,
      baseUrl:
        "http://alice:password-secret@127.0.0.1:8080/path-token/v1?token=query-secret#fragment-secret",
    };
    const sanitized = sanitizePiBaseUrlForDisplay(secretSettings.baseUrl);
    NodeAssert.equal(sanitized, "http://127.0.0.1:8080");
    NodeAssert.ok(!sanitized.includes("password-secret"));
    NodeAssert.ok(!sanitized.includes("path-token"));
    NodeAssert.ok(!sanitized.includes("query-secret"));
    NodeAssert.ok(!sanitized.includes("fragment-secret"));

    const manager = makePiInferenceServerManager(dependencies());
    const status = await manager.getStatus(instanceId, secretSettings);
    NodeAssert.equal(status.endpoint, sanitized);
    NodeAssert.ok(!JSON.stringify(status).includes("alice"));
    NodeAssert.ok(!JSON.stringify(status).includes("password-secret"));
    NodeAssert.ok(!JSON.stringify(status).includes("path-token"));
    NodeAssert.ok(!JSON.stringify(status).includes("query-secret"));
    NodeAssert.ok(!JSON.stringify(status).includes("fragment-secret"));
    NodeAssert.equal(sanitizePiBaseUrlForDisplay("not a URL?token=secret"), "(invalid endpoint)");
  });

  it("uses the Bonsai runtime profile with a single inference slot", () => {
    const args = buildPiInferenceServerArgs(settings);
    NodeAssert.equal(args[args.indexOf("--parallel") + 1], "1");
    NodeAssert.equal(args[args.indexOf("-c") + 1], "81920");
    NodeAssert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    NodeAssert.equal(args[args.indexOf("-m") + 1], settings.inferenceServerModelPath);
    NodeAssert.equal(args[args.indexOf("-ngl") + 1], "48");
    NodeAssert.equal(args[args.indexOf("--temp") + 1], "1");
    NodeAssert.equal(args[args.indexOf("--top-p") + 1], "0.95");
    NodeAssert.equal(args[args.indexOf("--cache-type-k") + 1], "q4_0");
    NodeAssert.equal(args[args.indexOf("--alias") + 1], PI_BONSAI_MODEL_ID);
    const ipv6Args = buildPiInferenceServerArgs({
      ...settings,
      baseUrl: "http://[::1]:8080/v1",
    });
    NodeAssert.equal(ipv6Args[ipv6Args.indexOf("--host") + 1], "::1");
  });

  it("uses configured launcher settings and rejects invalid ranges", () => {
    const configured = buildPiInferenceServerArgs({
      ...settings,
      inferenceServerContextSize: 32768,
      inferenceServerGpuLayers: 24,
      inferenceServerParallel: 2,
      inferenceServerTemperature: 0.7,
      inferenceServerTopK: 0,
      inferenceServerFlashAttention: false,
      inferenceServerCacheTypeK: "q8_0",
      inferenceServerReasoning: false,
    });
    NodeAssert.equal(configured[configured.indexOf("-c") + 1], "32768");
    NodeAssert.equal(configured[configured.indexOf("--parallel") + 1], "2");
    NodeAssert.equal(configured[configured.indexOf("--temp") + 1], "0.7");
    NodeAssert.equal(configured[configured.indexOf("-fa") + 1], "off");
    NodeAssert.equal(configured[configured.indexOf("--cache-type-k") + 1], "q8_0");
    NodeAssert.equal(configured[configured.indexOf("--reasoning") + 1], "off");
    NodeAssert.throws(
      () => buildPiInferenceServerArgs({ ...settings, inferenceServerParallel: 0 }),
      /Parallel slots/,
    );
    NodeAssert.throws(
      () => buildPiInferenceServerArgs({ ...settings, inferenceServerTemperature: 3 }),
      /Temperature/,
    );
    NodeAssert.throws(
      () => buildPiInferenceServerArgs({ ...settings, inferenceServerContextSize: 500 }),
      /Context size/,
    );
  });

  it("uses the configured model as the managed server alias", () => {
    const args = buildPiInferenceServerArgs({
      ...settings,
      model: "ft3-local/custom-local-model",
    });
    NodeAssert.equal(args[args.indexOf("--alias") + 1], "custom-local-model");
  });

  it("requires an exact model profile and switches argv only after the old owner stops", async () => {
    const model8 = "ft3-local/bonsai-2-8b";
    const model27 = "ft3-local/bonsai-2-27b";
    const base = { ...settings, baseUrl: "http://127.0.0.1:8181/v1" };
    const profileSettings = {
      ...base,
      inferenceServerProfiles: [
        {
          model: model8,
          baseUrl: base.baseUrl,
          executablePath: "C:/llama/llama-server.exe",
          modelPath: "C:/models/8B.gguf",
        },
        {
          model: model27,
          baseUrl: base.baseUrl,
          executablePath: "C:/llama/llama-server.exe",
          modelPath: "C:/models/27B.gguf",
        },
      ],
    };
    const eight = piInferenceSettingsForModel(profileSettings, model8);
    const twentySeven = piInferenceSettingsForModel(profileSettings, model27);
    NodeAssert.equal(eight.inferenceServerModelPath, "C:/models/8B.gguf");
    NodeAssert.equal(twentySeven.inferenceServerModelPath, "C:/models/27B.gguf");
    let expectedAlias = "bonsai-2-8b";
    let serverRunning = false;
    const deps = dependencies({
      isFile: async () => {
        serverRunning = true;
        return true;
      },
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health")
          return serverRunning ? new Response("ok") : new Response("offline", { status: 503 });
        return new Response(JSON.stringify({ data: [{ id: expectedAlias }] }));
      },
    });
    const manager = makePiInferenceServerManager(deps);
    await manager.start(instanceId, eight);
    await manager.ensureReady(instanceId, eight);
    NodeAssert.equal((await manager.getStatus(instanceId, eight)).ready, true);
    NodeAssert.equal(
      deps.spawnArgs[0]?.[deps.spawnArgs[0]!.indexOf("-m") + 1],
      NodePath.resolve("C:/models/8B.gguf"),
    );
    NodeAssert.equal(deps.spawnArgs[0]?.[deps.spawnArgs[0]!.indexOf("--alias") + 1], "bonsai-2-8b");
    const sharedMismatch = await manager.start(secondInstanceId, twentySeven);
    NodeAssert.match(sharedMismatch.error ?? "", /shared with another Pi instance/);
    manager.releaseInstance(secondInstanceId);
    const mismatch = await manager.start(instanceId, twentySeven);
    NodeAssert.equal(mismatch.ready, false);
    NodeAssert.match(mismatch.error ?? "", /Stop it, then Start/);
    await NodeAssert.rejects(
      manager.ensureReady(instanceId, twentySeven),
      /different model\/profile/,
    );
    NodeAssert.equal(deps.children.length, 1, "must not reuse or overlap the other model process");
    await manager.stop(instanceId, eight);
    serverRunning = false;
    expectedAlias = "bonsai-2-27b";
    await manager.start(instanceId, twentySeven);
    await manager.ensureReady(instanceId, twentySeven);
    NodeAssert.equal((await manager.getStatus(instanceId, twentySeven)).ready, true);
    NodeAssert.equal(deps.children.length, 2);
    NodeAssert.equal(
      deps.spawnArgs[1]?.[deps.spawnArgs[1]!.indexOf("-m") + 1],
      NodePath.resolve("C:/models/27B.gguf"),
    );
    NodeAssert.equal(
      deps.spawnArgs[1]?.[deps.spawnArgs[1]!.indexOf("--alias") + 1],
      "bonsai-2-27b",
    );
    await manager.stop(instanceId, twentySeven);
    serverRunning = false;
    expectedAlias = "bonsai-2-8b";
    await manager.start(instanceId, eight);
    await manager.ensureReady(instanceId, eight);
    NodeAssert.equal((await manager.getStatus(instanceId, eight)).ready, true);
    NodeAssert.equal(
      deps.spawnArgs[2]?.[deps.spawnArgs[2]!.indexOf("-m") + 1],
      NodePath.resolve("C:/models/8B.gguf"),
    );
    NodeAssert.equal(deps.spawnArgs[2]?.[deps.spawnArgs[2]!.indexOf("--alias") + 1], "bonsai-2-8b");
  });

  it("fails closed when the ready model catalog does not contain the selected alias", async () => {
    const probe = await probePiInferenceEndpoint(
      settings,
      async (input) =>
        requestUrl(input).pathname === "/health"
          ? new Response("ok")
          : new Response(JSON.stringify({ data: [{ id: "ternary-bonsai-8b" }] })),
      PI_BONSAI_MODEL_ID,
    );
    NodeAssert.equal(probe.ready, false);
    if (!probe.ready) NodeAssert.match(probe.reason, /does not serve the selected model/);
  });

  it("does not fall back to the legacy model when a selected model profile is absent", () => {
    NodeAssert.throws(
      () => piInferenceSettingsForModel(settings, "ft3-local/bonsai-2-27b"),
      /Configure a managed llama-server profile/,
    );
  });

  it("does not route a selected 27B model through stale legacy 8B paths", () => {
    const staleEightB = {
      ...settings,
      model: "ft3-local/bonsai-2-8b",
      inferenceServerExecutablePath: "C:/Bonsai/bin/cuda/llama-server.exe",
      inferenceServerModelPath: "C:/Bonsai/models/8B/Ternary-Bonsai-8B-PQ2_0.gguf",
      inferenceServerProfiles: [],
    };

    NodeAssert.throws(
      () => piInferenceSettingsForModel(staleEightB, "ft3-local/bonsai-2-27b"),
      /Configure a managed llama-server profile for the selected Pi model \(bonsai-2-27b\)/,
    );
  });

  it("deduplicates launches and emits one shared lifecycle to each waiting chat", async () => {
    let healthChecks = 0;
    const deps = dependencies({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health" && healthChecks++ === 0) {
          return new Response("not ready", { status: 503 });
        }
        return successfulFetch(input);
      },
    });
    const manager = makePiInferenceServerManager(deps);
    const eventsA: Array<string> = [];
    const eventsB: Array<string> = [];
    const localhostSettings = { ...settings, baseUrl: "http://localhost:8080/v1" };

    const [first, second, duplicateForChatA] = await Promise.all([
      manager.start(instanceId, localhostSettings, activity(threadA, eventsA)),
      manager.start(instanceId, settings, activity(threadB, eventsB, "automatic")),
      manager.start(instanceId, settings, activity(threadA, eventsA)),
    ]);
    await manager.ensureReady(instanceId, settings);

    NodeAssert.equal(deps.children.length, 1);
    NodeAssert.equal(first.owner, "ft3");
    NodeAssert.equal(second.owner, "ft3");
    NodeAssert.equal(duplicateForChatA.owner, "ft3");
    NodeAssert.equal(
      first.ready || second.ready || (await manager.getStatus(instanceId, settings)).ready,
      true,
    );
    NodeAssert.ok(eventsA.some((message) => message.includes("start requested")));
    NodeAssert.ok(eventsB.some((message) => message.includes("start request")));
    NodeAssert.equal(
      eventsA.filter((message) => message.includes("FT3 created one llama-server process")).length,
      1,
    );
    NodeAssert.equal(
      eventsB.filter((message) => message.includes("FT3 created one llama-server process")).length,
      1,
    );
    NodeAssert.equal(
      eventsA.filter((message) => message.includes("Joined the existing")).length,
      0,
    );
    NodeAssert.ok(eventsA.some((message) => message.includes(PI_BONSAI_MODEL_ID)));
    NodeAssert.ok(eventsB.some((message) => message.includes(PI_BONSAI_MODEL_ID)));
    NodeAssert.ok(!eventsA.join("\n").includes("Authorization"));
  });

  it("rejects a different model joining one in-flight start on every caller path", async () => {
    for (const joinPath of ["manual-start", "auto-ready", "manual-wait"] as const) {
      let releaseFirstProbe!: () => void;
      let markFirstProbe!: () => void;
      const firstProbeReached = new Promise<void>((resolve) => {
        markFirstProbe = resolve;
      });
      const firstProbeGate = new Promise<void>((resolve) => {
        releaseFirstProbe = resolve;
      });
      let healthCalls = 0;
      const deps = dependencies({
        fetch: async (input) => {
          const url = requestUrl(input);
          if (url.pathname === "/health" && healthCalls++ === 0) {
            markFirstProbe();
            await firstProbeGate;
            return new Response("not ready", { status: 503 });
          }
          return url.pathname === "/health"
            ? new Response("ok")
            : new Response(JSON.stringify({ data: [{ id: "bonsai-2-8b" }] }));
        },
      });
      const manager = makePiInferenceServerManager(deps);
      const eight = {
        ...settings,
        model: "ft3-local/bonsai-2-8b",
        inferenceServerModelPath: "C:/models/8B.gguf",
      };
      const twentySeven = {
        ...settings,
        model: "ft3-local/bonsai-2-27b",
        inferenceServerModelPath: "C:/models/27B.gguf",
      };
      const firstStart = manager.start(instanceId, eight);
      await firstProbeReached;

      if (joinPath === "manual-start") {
        const joined = await manager.start(secondInstanceId, twentySeven);
        NodeAssert.equal(joined.ready, false);
        NodeAssert.match(
          joined.error ?? "",
          /different Pi model\/server profile is already starting/,
        );
      } else if (joinPath === "auto-ready") {
        await NodeAssert.rejects(
          manager.ensureReady(secondInstanceId, twentySeven),
          /different Pi model\/server profile is already starting/,
        );
      } else {
        await NodeAssert.rejects(
          manager.waitForExistingReady(secondInstanceId, twentySeven),
          /different Pi model\/server profile is starting/,
        );
      }

      releaseFirstProbe();
      await firstStart;
      await manager.ensureReady(instanceId, eight);
      NodeAssert.equal(deps.children.length, 1, `${joinPath}: one owner only`);
      NodeAssert.equal(
        deps.spawnArgs[0]?.[deps.spawnArgs[0]!.indexOf("--alias") + 1],
        "bonsai-2-8b",
      );
      NodeAssert.equal(
        deps.spawnArgs[0]?.[deps.spawnArgs[0]!.indexOf("-m") + 1],
        NodePath.resolve("C:/models/8B.gguf"),
      );
      await manager.stop(instanceId, eight);
      manager.releaseInstance(secondInstanceId);
    }
  });

  it("waits for an already-started process without launching one when stopped", async () => {
    let endpointReady = false;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const deps = dependencies({
      fetch: async (input) => {
        if (!endpointReady) return new Response("warming", { status: 503 });
        return successfulFetch(input);
      },
      sleep: async (_milliseconds, signal) => {
        await probeGate;
        if (signal?.aborted) throw new Error("aborted");
      },
    });
    const manager = makePiInferenceServerManager(deps);
    const start = await manager.start(instanceId, settings);
    NodeAssert.equal(start.owner, "ft3");
    NodeAssert.equal(start.ready, false);

    const waiting = manager.waitForExistingReady(instanceId, settings);
    NodeAssert.equal(deps.children.length, 1);
    endpointReady = true;
    releaseProbe();
    const ready = await waiting;
    NodeAssert.equal(ready?.ready, true);
    NodeAssert.equal(deps.children.length, 1);

    await manager.stop(instanceId, settings);
    endpointReady = false;
    const afterStop = await manager.waitForExistingReady(instanceId, settings);
    NodeAssert.equal(afterStop, undefined);
    NodeAssert.equal(deps.children.length, 1, "send-side wait must not launch after Stop");
  });

  it("rejects a send-side wait after a start failed before creating an owner", async () => {
    const manager = makePiInferenceServerManager(
      dependencies({
        isFile: async () => false,
        fetch: async () => new Response("not ready", { status: 503 }),
      }),
    );
    const failed = await manager.start(instanceId, settings);
    NodeAssert.equal(failed.phase, "failed");
    NodeAssert.equal(failed.owner, "none");
    await NodeAssert.rejects(
      manager.waitForExistingReady(instanceId, settings),
      /configured llama-server executable was not found/,
    );
  });

  it("rejects a send-side wait when Stop races a warming owned process", async () => {
    const deps = dependencies({
      fetch: async () => new Response("warming", { status: 503 }),
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const manager = makePiInferenceServerManager(deps);
    const starting = await manager.start(instanceId, settings);
    NodeAssert.equal(starting.owner, "ft3");
    NodeAssert.equal(starting.ready, false);

    const waiting = manager.waitForExistingReady(instanceId, settings);
    const stopped = manager.stop(instanceId, settings);
    const [sendResult] = await Promise.allSettled([waiting, stopped]);
    NodeAssert.equal(sendResult.status, "rejected");
    if (sendResult.status === "rejected") {
      NodeAssert.match(String(sendResult.reason), /stopping|stopped/i);
    }
  });

  it("rejects a send-side wait while Stop is in progress for a ready owner", async () => {
    let healthChecks = 0;
    const deps = dependencies({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health" && healthChecks++ === 0) {
          return new Response("warming", { status: 503 });
        }
        return successfulFetch(input);
      },
    });
    const manager = makePiInferenceServerManager(deps);
    const messages: Array<string> = [];
    let markStopping!: () => void;
    const stopping = new Promise<void>((resolve) => {
      markStopping = resolve;
    });
    let releaseStopEvent!: () => void;
    const stopEventGate = new Promise<void>((resolve) => {
      releaseStopEvent = resolve;
    });
    const observer = makePiInferenceActivity({
      instanceId,
      threadId: threadA,
      source: "manual",
      emit: async (message) => {
        messages.push(message);
        if (message === "Stopping the FT3-owned inference server.") {
          markStopping();
          await stopEventGate;
        }
      },
    })!;
    await manager.start(instanceId, settings, observer);
    const ready = await manager.ensureReady(instanceId, settings);
    NodeAssert.equal(ready.ready, true);

    const stop = manager.stop(instanceId, settings);
    await stopping;
    await NodeAssert.rejects(
      manager.waitForExistingReady(instanceId, settings),
      /inference server is stopping/,
    );
    releaseStopEvent();
    await stop;
    NodeAssert.ok(messages.some((message) => message.startsWith("Ready:")));
  });

  it("notifies startup chats if the ready FT3-owned process later exits", async () => {
    let healthChecks = 0;
    const deps = dependencies({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health" && healthChecks++ === 0) {
          return new Response("warming", { status: 503 });
        }
        return successfulFetch(input);
      },
    });
    const manager = makePiInferenceServerManager(deps);
    const messages: Array<string> = [];
    const observer = activity(threadA, messages);
    await manager.start(instanceId, settings, observer);
    const ready = await manager.ensureReady(instanceId, settings, observer);
    NodeAssert.equal(ready.ready, true);
    NodeAssert.ok(messages.some((message) => message.startsWith("Ready:")));

    deps.children[0]!.emit("close", 17, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    NodeAssert.ok(
      messages.some((message) => message.includes("FT3-owned inference process exited (code 17)")),
    );
  });

  it("releases ended chat listeners but keeps activity for still-active chats", async () => {
    let healthChecks = 0;
    const deps = dependencies({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health" && healthChecks++ === 0) {
          return new Response("warming", { status: 503 });
        }
        return successfulFetch(input);
      },
    });
    const manager = makePiInferenceServerManager(deps);
    const endedMessages: Array<string> = [];
    const activeMessages: Array<string> = [];
    await manager.start(instanceId, settings, activity(threadA, endedMessages));
    await manager.start(instanceId, settings, activity(threadB, activeMessages));
    await manager.ensureReady(instanceId, settings);

    manager.releaseActivity(instanceId, threadA, settings.baseUrl);
    deps.children[0]!.emit("close", 17, null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    NodeAssert.ok(!endedMessages.some((message) => message.includes("process exited (code 17)")));
    NodeAssert.ok(activeMessages.some((message) => message.includes("process exited (code 17)")));
  });

  it("reuses and cannot stop an external ready endpoint", async () => {
    const deps = dependencies();
    const manager = makePiInferenceServerManager(deps);
    const status = await manager.start(instanceId, settings);
    const stopped = await manager.stop(instanceId, settings);
    NodeAssert.equal(status.owner, "external");
    NodeAssert.equal(status.ready, true);
    NodeAssert.equal(status.canStop, false);
    NodeAssert.equal(stopped.owner, "external");
    NodeAssert.equal(deps.children.length, 0);
  });

  it("marks changed launch settings pending until the managed server is restarted", async () => {
    const deps = dependencies({ fetch: async () => new Response("not ready", { status: 503 }) });
    const manager = makePiInferenceServerManager(deps);
    const initial = await manager.start(instanceId, settings);
    NodeAssert.equal(initial.owner, "ft3");
    NodeAssert.equal(initial.pendingRestart, false);
    const changed = await manager.getStatus(instanceId, {
      ...settings,
      inferenceServerContextSize: 32768,
    });
    NodeAssert.equal(changed.pendingRestart, true);
    const changedExecutable = await manager.getStatus(instanceId, {
      ...settings,
      inferenceServerExecutablePath: "C:\\Bonsai\\bin\\another-llama-server.exe",
    });
    NodeAssert.equal(changedExecutable.pendingRestart, true);
    await manager.stop(instanceId, settings);
    const restarted = await manager.start(instanceId, {
      ...settings,
      inferenceServerContextSize: 32768,
    });
    NodeAssert.equal(restarted.owner, "ft3");
    NodeAssert.equal(deps.spawnArgs.length, 2);
    NodeAssert.equal(deps.spawnArgs[1]?.[deps.spawnArgs[1]!.indexOf("-c") + 1], "32768");
    await manager.stop(instanceId, { ...settings, inferenceServerContextSize: 32768 });
  });

  it("can stop the old owned process after Pi switches to a different external local endpoint", async () => {
    const deps = dependencies({
      fetch: async (input) =>
        requestUrl(input).port === "8080"
          ? new Response("not ready", { status: 503 })
          : successfulFetch(input),
    });
    const manager = makePiInferenceServerManager(deps);
    const started = await manager.start(instanceId, settings);
    NodeAssert.equal(started.owner, "ft3");
    NodeAssert.equal(deps.children.length, 1);

    const changedSettings = { ...settings, baseUrl: "http://127.0.0.1:8181/v1" };
    const changedStatus = await manager.getStatus(instanceId, changedSettings);
    NodeAssert.equal(changedStatus.owner, "external");
    NodeAssert.equal(changedStatus.ready, true);
    NodeAssert.equal(changedStatus.canStop, false);
    NodeAssert.equal(changedStatus.orphanedManagedEndpoint, "http://127.0.0.1:8080");
    NodeAssert.equal(deps.children.length, 1, "the external endpoint must not be spawned by FT3");

    const stopped = await manager.stop(instanceId, changedSettings);
    NodeAssert.equal(stopped.owner, "none");
    NodeAssert.deepEqual(deps.children[0]?.killSignals, ["SIGTERM"]);
    const externalAfterStop = await manager.getStatus(instanceId, changedSettings);
    NodeAssert.equal(externalAfterStop.owner, "external");
    NodeAssert.equal(externalAfterStop.ready, true);
    NodeAssert.equal(externalAfterStop.orphanedManagedEndpoint, null);
    NodeAssert.equal(deps.children.length, 1);
  });

  it("protects a shared endpoint from Stop until every other Pi instance switches away", async () => {
    const deps = dependencies({
      fetch: async (input) =>
        requestUrl(input).port === "8080"
          ? new Response("not ready", { status: 503 })
          : successfulFetch(input),
    });
    const manager = makePiInferenceServerManager(deps);
    const startedByA = await manager.start(instanceId, settings);
    NodeAssert.equal(startedByA.owner, "ft3");

    // B shares A's endpoint with different launch settings. It observes the
    // owner, but cannot stop A's process while its endpoint claim is active.
    const settingsB = { ...settings, inferenceServerContextSize: 32768 };
    const sharedStatus = await manager.getStatus(secondInstanceId, settingsB);
    NodeAssert.equal(sharedStatus.owner, "ft3");
    NodeAssert.equal(sharedStatus.pendingRestart, true);
    NodeAssert.equal(sharedStatus.usedByOtherInstances, true);
    NodeAssert.equal(sharedStatus.canStop, false);
    const deniedStop = await manager.stop(secondInstanceId, settingsB);
    NodeAssert.equal(deniedStop.owner, "ft3");
    NodeAssert.equal(deniedStop.usedByOtherInstances, true);
    NodeAssert.deepEqual(deps.children[0]?.killSignals, []);

    // B's status request with its new URL releases its old endpoint claim. Its
    // Stop can never reach or kill A's child while A still uses endpoint E.
    const settingsBAway = { ...settingsB, baseUrl: "http://127.0.0.1:8181/v1" };
    const switchedStatus = await manager.getStatus(secondInstanceId, settingsBAway);
    NodeAssert.equal(switchedStatus.owner, "external");
    NodeAssert.equal(switchedStatus.orphanedManagedEndpoint, null);
    const switchedStop = await manager.stop(secondInstanceId, settingsBAway);
    NodeAssert.equal(switchedStop.owner, "external");
    NodeAssert.deepEqual(deps.children[0]?.killSignals, []);

    const statusForA = await manager.getStatus(instanceId, settings);
    NodeAssert.equal(statusForA.owner, "ft3");
    NodeAssert.equal(statusForA.usedByOtherInstances, false);
    NodeAssert.equal(statusForA.canStop, true);
    const stoppedByA = await manager.stop(instanceId, settings);
    NodeAssert.equal(stoppedByA.phase, "stopped");
    NodeAssert.deepEqual(deps.children[0]?.killSignals, ["SIGTERM"]);
    NodeAssert.equal(deps.children.length, 1, "the external endpoint is never managed or stopped");
  });

  it("releases stale endpoint claims when a Pi provider scope closes without another status poll", async () => {
    const deps = dependencies({
      fetch: async (input) =>
        requestUrl(input).port === "8080"
          ? new Response("not ready", { status: 503 })
          : successfulFetch(input),
    });
    const manager = makePiInferenceServerManager(deps);
    const startedByA = await manager.start(instanceId, settings);
    NodeAssert.equal(startedByA.owner, "ft3");
    let stoppedA = false;
    try {
      const settingsB = { ...settings, inferenceServerContextSize: 32768 };
      const sharedStatus = await manager.getStatus(secondInstanceId, settingsB);
      NodeAssert.equal(sharedStatus.usedByOtherInstances, true);
      NodeAssert.deepEqual(deps.children[0]?.killSignals, []);

      // ProviderInstanceRegistry closes the old Pi adapter scope on settings
      // replacement/removal. That lifecycle hook must release B's old claim;
      // no B status RPC is issued after its endpoint changes.
      manager.releaseInstance(secondInstanceId);
      const changedSettingsB = { ...settingsB, baseUrl: "http://127.0.0.1:8181/v1" };
      const stoppedByB = await manager.stop(secondInstanceId, changedSettingsB);
      NodeAssert.equal(stoppedByB.owner, "external");
      NodeAssert.deepEqual(deps.children[0]?.killSignals, []);

      const statusForA = await manager.getStatus(instanceId, settings);
      NodeAssert.equal(statusForA.usedByOtherInstances, false);
      NodeAssert.equal(statusForA.canStop, true);
      const stoppedByA = await manager.stop(instanceId, settings);
      stoppedA = true;
      NodeAssert.equal(stoppedByA.phase, "stopped");
      NodeAssert.deepEqual(deps.children[0]?.killSignals, ["SIGTERM"]);
    } finally {
      if (!stoppedA) await manager.stop(instanceId, settings);
      manager.shutdown();
    }
  });

  it("shows a settings hint and disables Start when a local endpoint has no managed paths", async () => {
    const manager = makePiInferenceServerManager(
      dependencies({
        fetch: async () => new Response("not ready", { status: 503 }),
      }),
    );
    const status = await manager.getStatus(instanceId, {
      ...settings,
      inferenceServerExecutablePath: "",
      inferenceServerModelPath: "",
    });
    NodeAssert.equal(status.phase, "stopped");
    NodeAssert.equal(status.canStart, false);
    NodeAssert.match(status.error ?? "", /Configure both the llama-server executable and GGUF/);
  });

  it("enables manual Start for valid paths even when automatic start is off", async () => {
    const manager = makePiInferenceServerManager(
      dependencies({ fetch: async () => new Response("not ready", { status: 503 }) }),
    );
    const status = await manager.getStatus(instanceId, settings);

    NodeAssert.equal(status.phase, "stopped");
    NodeAssert.equal(status.canStart, true);
    NodeAssert.equal(status.endpoint, "http://127.0.0.1:8080");
    NodeAssert.match(status.error ?? "", /HTTP \/health returned 503/);
  });

  it("stops only the exact child process it created", async () => {
    let healthChecks = 0;
    const deps = dependencies({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health" && healthChecks++ === 0) {
          return new Response("not ready", { status: 503 });
        }
        return successfulFetch(input);
      },
    });
    const manager = makePiInferenceServerManager(deps);
    await manager.start(instanceId, settings);
    const status = await manager.stop(instanceId, settings);
    NodeAssert.equal(status.phase, "stopped");
    NodeAssert.deepEqual(deps.children[0]?.killSignals, ["SIGTERM"]);
    NodeAssert.equal(deps.children.length, 1);
  });

  it("reports sparse readiness progress, fails with a cause, and can retry the same process", async () => {
    let now = 0;
    let endpointReady = false;
    const messages: Array<string> = [];
    const deps = dependencies({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      fetch: async (input) => {
        if (!endpointReady) return new Response("warming", { status: 503 });
        return successfulFetch(input);
      },
    });
    const manager = makePiInferenceServerManager(deps);
    const observer = activity(threadA, messages);

    await NodeAssert.rejects(
      manager.ensureReady(instanceId, settings, observer),
      /Readiness timed out/,
    );
    const progress = messages.filter((message) => message.startsWith("Still waiting"));
    NodeAssert.ok(progress.length > 0 && progress.length <= 12);
    NodeAssert.ok(messages.some((message) => message.includes("Readiness timed out after 600s")));
    NodeAssert.equal(deps.children.length, 1);

    endpointReady = true;
    const retried = await manager.start(instanceId, settings, observer);
    NodeAssert.equal(retried.ready, true);
    NodeAssert.deepEqual(retried.modelIds, [PI_BONSAI_MODEL_ID]);
    NodeAssert.equal(deps.children.length, 1);
    await manager.stop(instanceId, settings);
  });

  it("queues concurrent chats FIFO for llama-server --parallel 1 and supports cancellation", async () => {
    const manager = makePiInferenceServerManager(dependencies());
    const firstRelease = await manager.acquireRequestSlot(settings.baseUrl);
    const order: Array<string> = [];
    let queued = false;
    const secondPromise = manager
      .acquireRequestSlot(settings.baseUrl, () => {
        queued = true;
      })
      .then((release) => {
        order.push("second");
        return release;
      });
    NodeAssert.equal(queued, true);
    await Promise.resolve();
    NodeAssert.deepEqual(order, []);
    firstRelease();
    const secondRelease = await secondPromise;
    secondRelease();
    NodeAssert.deepEqual(order, ["second"]);

    const thirdRelease = await manager.acquireRequestSlot(settings.baseUrl);
    const controller = new AbortController();
    const cancelled = manager.acquireRequestSlot(settings.baseUrl, undefined, controller.signal);
    controller.abort();
    await NodeAssert.rejects(cancelled, /interrupted while queued/);
    thirdRelease();
  });

  it("offers a Bonsai preset only when both host files exist and assigns its stable model ID", async () => {
    const files = new Set([
      "C:\\root\\bin\\cuda\\llama-server.exe",
      "C:\\root\\models\\bonsai2-gguf\\27B\\Ternary-Bonsai-2-27B-PQ2_0.gguf",
    ]);
    const preset = await detectPiBonsaiPreset({
      isFile: async (file) => files.has(file),
      environment: { BONSAI_DEMO_HOME: "C:\\root" } as NodeJS.ProcessEnv,
    });
    NodeAssert.deepEqual(preset, {
      executablePath: "C:\\root\\bin\\cuda\\llama-server.exe",
      modelPath: "C:\\root\\models\\bonsai2-gguf\\27B\\Ternary-Bonsai-2-27B-PQ2_0.gguf",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: PI_BONSAI_MODEL_ID,
    });
  });

  it("does not search developer-specific Bonsai roots for other users", async () => {
    const checkedPaths: Array<string> = [];
    const preset = await detectPiBonsaiPreset({
      isFile: async (file) => {
        checkedPaths.push(file);
        return true;
      },
      environment: {},
    });

    NodeAssert.equal(preset, null);
    NodeAssert.deepEqual(checkedPaths, []);
  });

  it("detects the standard Bonsai files in a user-selected root without an environment variable", async () => {
    const rootPath = await makeBonsaiRoot();
    try {
      const files = await writeBonsaiFiles(rootPath);
      const preset = await detectPiBonsaiPreset({ rootPath, environment: {} });

      NodeAssert.deepEqual(preset, {
        ...files,
        baseUrl: "http://127.0.0.1:8080/v1",
        model: PI_BONSAI_MODEL_ID,
      });
      NodeAssert.ok(preset);
      const args = buildPiInferenceServerArgs({
        ...settings,
        baseUrl: preset.baseUrl,
        model: preset.model,
        inferenceServerExecutablePath: preset.executablePath,
        inferenceServerModelPath: preset.modelPath,
      });
      NodeAssert.equal(args[args.indexOf("-m") + 1], files.modelPath);
      NodeAssert.equal(args[args.indexOf("--alias") + 1], PI_BONSAI_MODEL_ID);
      NodeAssert.equal(args[args.indexOf("--port") + 1], "8080");
    } finally {
      await NodeFSP.rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps an invalid explicitly selected folder from falling back to a different configured root", async () => {
    const selectedRoot = await makeBonsaiRoot();
    const configuredRoot = await makeBonsaiRoot();
    try {
      await writeBonsaiFiles(configuredRoot);
      const preset = await detectPiBonsaiPreset({
        rootPath: selectedRoot,
        environment: { BONSAI_DEMO_HOME: configuredRoot } as NodeJS.ProcessEnv,
      });

      NodeAssert.equal(preset, null);
    } finally {
      await Promise.all([
        NodeFSP.rm(selectedRoot, { recursive: true, force: true }),
        NodeFSP.rm(configuredRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects matching directory names when the Bonsai executable or model is not a file", async () => {
    const rootPath = await makeBonsaiRoot();
    try {
      const executablePath = NodePath.join(rootPath, "bin", "cuda", "llama-server.exe");
      const modelPath = NodePath.join(
        rootPath,
        "models",
        "bonsai2-gguf",
        "27B",
        "Ternary-Bonsai-2-27B-PQ2_0.gguf",
      );
      await NodeFSP.mkdir(executablePath, { recursive: true });
      await NodeFSP.mkdir(modelPath, { recursive: true });

      const preset = await detectPiBonsaiPreset({ rootPath, environment: {} });

      NodeAssert.equal(preset, null);
    } finally {
      await NodeFSP.rm(rootPath, { recursive: true, force: true });
    }
  });
});
