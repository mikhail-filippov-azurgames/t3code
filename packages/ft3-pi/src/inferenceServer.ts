// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off - The managed llama-server child must be owned exactly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { normalizePiBaseUrl, normalizePiApiKey, piModelIdFromSlug } from "./agentDir.ts";

const PI_INFERENCE_CONFIG_ENV = "T3CODE_FT3_PI_INFERENCE_CONFIG";

const READINESS_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 1_000;

export interface PiInferenceProfile {
  readonly model: string;
  readonly baseUrl: string;
  readonly executablePath: string;
  readonly modelPath: string;
  readonly gpuLayers?: number | undefined;
  readonly contextSize?: number | undefined;
  readonly parallel?: number | undefined;
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
  readonly topK?: number | undefined;
  readonly minP?: number | undefined;
  readonly flashAttention?: boolean | undefined;
  readonly cacheTypeK?: string | undefined;
  readonly cacheTypeV?: string | undefined;
  readonly jinja?: boolean | undefined;
  readonly reasoning?: boolean | undefined;
  readonly reasoningEffort?: string | undefined;
}

export interface PiInferenceConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly profiles: ReadonlyArray<PiInferenceProfile>;
}

const emptyPiInferenceConfig = (): PiInferenceConfig => ({
  baseUrl: normalizePiBaseUrl(undefined),
  apiKey: normalizePiApiKey(undefined),
  profiles: [],
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseProfile(value: unknown, index: number, defaultBaseUrl: string): PiInferenceProfile {
  const entry = record(value);
  if (!entry) throw new Error(`Pi inference profile ${index} must be an object.`);
  const model = optionalString(entry.model);
  const executablePath = optionalString(entry.executablePath);
  const modelPath = optionalString(entry.modelPath);
  if (!model || !executablePath || !modelPath) {
    throw new Error(`Pi inference profile ${index} requires model, executablePath and modelPath.`);
  }
  return {
    model,
    baseUrl: optionalString(entry.baseUrl) ?? defaultBaseUrl,
    executablePath,
    modelPath,
    gpuLayers: optionalNumber(entry.gpuLayers),
    contextSize: optionalNumber(entry.contextSize),
    parallel: optionalNumber(entry.parallel),
    temperature: optionalNumber(entry.temperature),
    topP: optionalNumber(entry.topP),
    topK: optionalNumber(entry.topK),
    minP: optionalNumber(entry.minP),
    flashAttention: optionalBoolean(entry.flashAttention),
    cacheTypeK: optionalString(entry.cacheTypeK),
    cacheTypeV: optionalString(entry.cacheTypeV),
    jinja: optionalBoolean(entry.jinja),
    reasoning: optionalBoolean(entry.reasoning),
    reasoningEffort: optionalString(entry.reasoningEffort),
  };
}

export function parsePiInferenceConfig(value: unknown): PiInferenceConfig {
  const document = record(value);
  if (!document) throw new Error("Pi inference config must be a JSON object.");
  const baseUrl = normalizePiBaseUrl(optionalString(document.baseUrl));
  const apiKey = normalizePiApiKey(optionalString(document.apiKey));
  const rawProfiles = document.profiles;
  if (rawProfiles !== undefined && !Array.isArray(rawProfiles)) {
    throw new Error("Pi inference config profiles must be an array.");
  }
  return {
    baseUrl,
    apiKey,
    profiles: (rawProfiles ?? []).map((profile, index) => parseProfile(profile, index, baseUrl)),
  };
}

export function resolvePiInferenceConfigPath(input: {
  readonly stateDir: string;
  readonly instanceId: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): string {
  const override = input.environment?.[PI_INFERENCE_CONFIG_ENV]?.trim();
  return override && override.length > 0
    ? NodePath.resolve(override)
    : NodePath.join(input.stateDir, "pi", input.instanceId, "inference-profiles.json");
}

/** A missing config file means "no managed profiles", not a broken instance. */
export async function loadPiInferenceConfig(filePath: string): Promise<PiInferenceConfig> {
  let text: string;
  try {
    text = await NodeFSP.readFile(filePath, "utf8");
  } catch (cause) {
    if (record(cause)?.code === "ENOENT") return emptyPiInferenceConfig();
    throw cause;
  }
  try {
    return parsePiInferenceConfig(JSON.parse(text));
  } catch (cause) {
    throw new Error(
      `Pi inference config ${filePath} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function resolvePiInferenceProfile(
  config: PiInferenceConfig,
  selectedModel: string | undefined,
): PiInferenceProfile | undefined {
  if (!selectedModel) return undefined;
  const selectedId = piModelIdFromSlug(selectedModel) ?? selectedModel.trim();
  return config.profiles.find(
    (profile) =>
      profile.model === selectedModel ||
      (piModelIdFromSlug(profile.model) ?? profile.model) === selectedId,
  );
}

/** Managed models.json points at the configured endpoint, never at a user Pi catalog. */
export function piInferenceModelsBaseUrl(config: PiInferenceConfig): string {
  return config.profiles.length === 1 ? config.profiles[0]!.baseUrl : config.baseUrl;
}

function parsePiLocalEndpoint(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "http:" ||
      (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
    return url;
  } catch {
    return undefined;
  }
}

/** The fixed llama-server profile; no shell is involved in launching it. */
export function buildPiInferenceServerArgs(profile: PiInferenceProfile): ReadonlyArray<string> {
  const url = parsePiLocalEndpoint(profile.baseUrl);
  if (!url) throw new Error("The inference endpoint must use HTTP on a loopback address.");
  const port = url.port || "80";
  const host = url.hostname.toLowerCase() === "[::1]" ? "::1" : "127.0.0.1";
  const modelId = piModelIdFromSlug(profile.model);
  const gpuLayers = profile.gpuLayers ?? 48;
  const contextSize = profile.contextSize ?? 81_920;
  const parallel = profile.parallel ?? 1;
  const temperature = profile.temperature ?? 1;
  const topP = profile.topP ?? 0.95;
  const topK = profile.topK ?? 20;
  const minP = profile.minP ?? 0.05;
  if (!Number.isInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > 999) {
    throw new Error("GPU layers must be between 0 and 999.");
  }
  if (!Number.isInteger(contextSize) || contextSize < 512 || contextSize > 1_048_576) {
    throw new Error("Context size must be between 512 and 1048576 tokens.");
  }
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 64) {
    throw new Error("Parallel slots must be between 1 and 64.");
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("Temperature must be between 0 and 2.");
  }
  if (!Number.isFinite(topP) || topP < 0 || topP > 1) {
    throw new Error("Top-p must be between 0 and 1.");
  }
  if (!Number.isInteger(topK) || topK < 0 || topK > 1000) {
    throw new Error("Top-k must be between 0 and 1000.");
  }
  if (!Number.isFinite(minP) || minP < 0 || minP > 1) {
    throw new Error("Min-p must be between 0 and 1.");
  }
  return [
    "-m",
    NodePath.resolve(profile.modelPath),
    ...(modelId ? ["--alias", modelId] : []),
    "--host",
    host,
    "--port",
    port,
    "-ngl",
    String(gpuLayers),
    "-fa",
    profile.flashAttention === false ? "off" : "on",
    "-c",
    String(contextSize),
    "--parallel",
    String(parallel),
    "--temp",
    String(temperature),
    "--top-p",
    String(topP),
    "--top-k",
    String(topK),
    "--min-p",
    String(minP),
    ...(profile.jinja === false ? [] : ["--jinja"]),
    "--cache-type-k",
    profile.cacheTypeK ?? "q4_0",
    "--cache-type-v",
    profile.cacheTypeV ?? "q4_0",
    "--reasoning",
    profile.reasoning === false ? "off" : "on",
    "--reasoning-effort",
    profile.reasoningEffort ?? "medium",
  ];
}

export type PiEndpointProbe =
  | { readonly ready: true; readonly modelIds: ReadonlyArray<string> }
  | { readonly ready: false; readonly modelIds: ReadonlyArray<string>; readonly reason: string };

async function probePiInferenceEndpoint(
  input: { readonly baseUrl: string; readonly apiKey?: string | undefined },
  fetcher: typeof fetch = fetch,
  expectedModelId?: string,
): Promise<PiEndpointProbe> {
  const base = parsePiLocalEndpoint(input.baseUrl);
  if (!base) {
    return {
      ready: false,
      modelIds: [],
      reason: "The configured endpoint is not a local HTTP loopback address.",
    };
  }
  const root = new URL(base);
  root.pathname = "/";
  root.search = "";
  root.hash = "";
  let health: Response;
  try {
    health = await fetcher(new URL("health", root), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (cause) {
    return {
      ready: false,
      modelIds: [],
      reason:
        cause instanceof Error && cause.name === "TimeoutError"
          ? "Timed out waiting for HTTP /health."
          : "HTTP /health is not responding yet.",
    };
  }
  if (!health.ok)
    return { ready: false, modelIds: [], reason: `HTTP /health returned ${health.status}.` };

  const modelsUrl = new URL(base);
  modelsUrl.pathname = `${base.pathname.replace(/\/+$/, "")}/models`;
  const apiKey = input.apiKey?.trim() ?? "";
  let modelsResponse: Response;
  try {
    modelsResponse = await fetcher(modelsUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(apiKey.length > 0 ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
  } catch (cause) {
    return {
      ready: false,
      modelIds: [],
      reason:
        cause instanceof Error && cause.name === "TimeoutError"
          ? "Timed out waiting for HTTP /v1/models."
          : "HTTP /v1/models is not responding yet.",
    };
  }
  if (!modelsResponse.ok) {
    return {
      ready: false,
      modelIds: [],
      reason: `HTTP /v1/models returned ${modelsResponse.status}.`,
    };
  }
  let body: unknown;
  try {
    body = await modelsResponse.json();
  } catch {
    return { ready: false, modelIds: [], reason: "HTTP /v1/models returned invalid JSON." };
  }
  const data = record(body)?.data;
  if (!Array.isArray(data)) {
    return { ready: false, modelIds: [], reason: "HTTP /v1/models did not contain a data array." };
  }
  const modelIds = [
    ...new Set(
      data.flatMap((entry: unknown) => {
        const id = record(entry)?.id;
        if (typeof id !== "string" || id.trim().length === 0) return [];
        const safeId = [...id]
          .filter((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code > 0x1f && (code < 0x7f || code > 0x9f);
          })
          .join("")
          .trim()
          .slice(0, 160);
        return [safeId];
      }),
    ),
  ].filter((id) => id.length > 0);
  if (modelIds.length === 0) {
    return {
      ready: false,
      modelIds: [],
      reason: "HTTP /v1/models returned no parseable model IDs.",
    };
  }
  if (expectedModelId && !modelIds.includes(expectedModelId)) {
    return {
      ready: false,
      modelIds,
      reason: `Endpoint does not serve the selected model (${expectedModelId}); reported: ${modelIds.join(", ")}.`,
    };
  }
  return { ready: true, modelIds };
}

type ManagedChild = Pick<NodeChildProcess.ChildProcess, "on" | "kill" | "exitCode" | "signalCode">;

export interface PiInferenceServerDependencies {
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly windowsHide: true; readonly stdio: "ignore" },
  ) => ManagedChild;
  readonly isFile: (filePath: string) => Promise<boolean>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

interface ServerOwner {
  readonly key: string;
  readonly executablePath: string;
  readonly launchArgs: ReadonlyArray<string>;
  readonly child: ManagedChild;
  readonly readyPromise: Promise<void>;
  readonly rejectReady: (reason: Error) => void;
  readonly resolveReady: () => void;
  alive: boolean;
  ready: boolean;
}

function endpointKey(url: URL): string {
  const normalized = new URL(url);
  if (normalized.hostname.toLowerCase() === "localhost") normalized.hostname = "127.0.0.1";
  return normalized.toString().replace(/\/$/, "");
}

const defaultDependencies: PiInferenceServerDependencies = {
  spawn: (command, args, options) => NodeChildProcess.spawn(command, [...args], { ...options }),
  isFile: async (filePath) => {
    try {
      return (await NodeFSP.stat(filePath)).isFile();
    } catch {
      return false;
    }
  },
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export interface PiInferenceServerManager {
  /** Start the configured profile when needed and resolve only after the endpoint serves it. */
  readonly ensureReady: (model: string | undefined) => Promise<void>;
  readonly stopAll: () => void;
}

/** Auto-start only: slots and manual start/stop belong to a later slice. */
export function makePiInferenceServerManager(
  config: PiInferenceConfig,
  overrideDependencies: Partial<PiInferenceServerDependencies> = {},
): PiInferenceServerManager {
  const deps: PiInferenceServerDependencies = { ...defaultDependencies, ...overrideDependencies };
  const owners = new Map<string, ServerOwner>();
  const launches = new Map<string, Promise<void>>();

  const stopOwner = (owner: ServerOwner) => {
    if (!owner.alive) return;
    owner.alive = false;
    try {
      owner.child.kill();
    } catch {
      // Process already gone; the readiness wait reports the outcome.
    }
  };

  const start = async (profile: PiInferenceProfile, key: string): Promise<ServerOwner> => {
    const executable = NodePath.resolve(profile.executablePath);
    const modelPath = NodePath.resolve(profile.modelPath);
    if (/\.ps1$/i.test(executable)) {
      throw new Error(
        "Configure the direct llama-server executable; PowerShell launchers are not run.",
      );
    }
    if (!(await deps.isFile(executable))) {
      throw new Error("The configured llama-server executable was not found as a file.");
    }
    if (!(await deps.isFile(modelPath))) {
      throw new Error("The configured GGUF model file was not found as a file.");
    }
    const args = buildPiInferenceServerArgs(profile);
    let resolveReady = () => {};
    let rejectReady = (_reason: Error) => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void readyPromise.catch(() => undefined);
    const child = deps.spawn(executable, args, {
      cwd: NodePath.dirname(executable),
      windowsHide: true,
      stdio: "ignore",
    });
    const owner: ServerOwner = {
      key,
      executablePath: executable,
      launchArgs: args,
      child,
      readyPromise,
      rejectReady,
      resolveReady,
      alive: true,
      ready: false,
    };
    owners.set(key, owner);
    child.on("error", (cause: unknown) => {
      owner.alive = false;
      owner.rejectReady(
        new Error(
          `FT3 could not start the configured llama-server executable (${String((cause as { code?: unknown })?.code ?? cause)}).`,
        ),
      );
    });
    child.on("close", (code: number | null) => {
      owner.alive = false;
      owner.rejectReady(
        new Error(
          `The FT3-owned inference process exited before readiness (code ${code === null ? "unknown" : code}).`,
        ),
      );
    });
    void watchReadiness(owner, profile);
    return owner;
  };

  const watchReadiness = async (owner: ServerOwner, profile: PiInferenceProfile) => {
    const expectedModelId = piModelIdFromSlug(profile.model);
    const deadline = deps.now() + READINESS_TIMEOUT_MS;
    let reason = "The inference endpoint did not become ready.";
    while (owner.alive && deps.now() < deadline) {
      const probe = await probePiInferenceEndpoint(
        { baseUrl: profile.baseUrl, apiKey: config.apiKey },
        deps.fetch,
        expectedModelId,
      );
      if (probe.ready) {
        owner.ready = true;
        owner.resolveReady();
        return;
      }
      reason = probe.reason;
      await deps.sleep(PROBE_INTERVAL_MS);
    }
    if (owner.alive) {
      owner.alive = false;
      try {
        owner.child.kill();
      } catch {
        // Keep the readiness failure as the reported cause.
      }
    }
    owner.rejectReady(new Error(reason));
  };

  const ensureReady = async (model: string | undefined): Promise<void> => {
    const profile = resolvePiInferenceProfile(config, model);
    if (!profile) return;
    const url = parsePiLocalEndpoint(profile.baseUrl);
    if (!url) throw new Error("The inference endpoint must use HTTP on a loopback address.");
    const key = endpointKey(url);
    const expectedModelId = piModelIdFromSlug(profile.model);
    const existingProbe = await probePiInferenceEndpoint(
      { baseUrl: profile.baseUrl, apiKey: config.apiKey },
      deps.fetch,
      expectedModelId,
    );
    if (existingProbe.ready) return;

    const existing = owners.get(key);
    if (existing?.alive) {
      if (
        existing.executablePath !== NodePath.resolve(profile.executablePath) ||
        JSON.stringify(existing.launchArgs) !== JSON.stringify(buildPiInferenceServerArgs(profile))
      ) {
        throw new Error(
          "A different Pi model/server profile is already running at this endpoint; stop it first.",
        );
      }
      if (!existing.ready) {
        await existing.readyPromise;
        return;
      }
      throw new Error(
        "The FT3-owned inference server was ready but stopped responding; restart the instance.",
      );
    }

    const inFlight = launches.get(key);
    if (inFlight) {
      await inFlight;
      return;
    }
    let settle: () => void = () => {};
    let fail: (reason: Error) => void = () => {};
    const flight = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    void flight.catch(() => undefined);
    launches.set(key, flight);
    void (async () => {
      try {
        const owner = await start(profile, key);
        await owner.readyPromise;
        settle();
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        launches.delete(key);
      }
    })();
    await flight;
  };

  return {
    ensureReady,
    stopAll: () => {
      for (const owner of owners.values()) stopOwner(owner);
      owners.clear();
    },
  };
}
