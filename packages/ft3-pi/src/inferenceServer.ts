// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off - The managed llama-server child must be owned exactly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  normalizePiApiKey,
  normalizePiBaseUrl,
  normalizePiModelSlug,
  piModelIdFromSlug,
} from "./agentDir.ts";
import type { PiBonsaiPreset } from "./rpc-contracts.ts";

const PI_INFERENCE_CONFIG_ENV = "T3CODE_FT3_PI_INFERENCE_CONFIG";
const PI_BONSAI_ENV_ROOT = "BONSAI_DEMO_HOME";

export const PI_BONSAI_MODEL_ID = "bonsai-2-27b";
const PI_BONSAI_BASE_URL = "http://127.0.0.1:8080/v1";

const READINESS_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 1_000;
const STOP_TIMEOUT_MS = 5_000;

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

/**
 * V1 kept the default llama-server settings and extra per-model profiles in two
 * places. V2 reads one profile file, so fold both into a single ordered list.
 */
export function derivePiInferenceConfigFromLegacySettings(
  value: unknown,
  options: { readonly fallbackBaseUrl?: string | undefined } = {},
): PiInferenceConfig | undefined {
  const config = record(value);
  if (!config) return undefined;
  const configBaseUrl = normalizePiBaseUrl(optionalString(config.baseUrl));
  const baseUrl = normalizePiBaseUrl(optionalString(options.fallbackBaseUrl) ?? configBaseUrl);
  const apiKey = normalizePiApiKey(optionalString(config.apiKey));
  const profiles: Array<PiInferenceProfile> = [];
  const seen = new Set<string>();
  const push = (profile: PiInferenceProfile | undefined) => {
    if (!profile) return;
    const model = normalizePiModelSlug(profile.model);
    if (!model) return;
    const id = piModelIdFromSlug(model) ?? model;
    if (seen.has(id)) return;
    seen.add(id);
    profiles.push({ ...profile, model });
  };

  const explicit = new Map<string, PiInferenceProfile>();
  for (const entry of Array.isArray(config.inferenceServerProfiles)
    ? config.inferenceServerProfiles
    : []) {
    try {
      const profile = parseProfile(entry, explicit.size, configBaseUrl);
      const id = piModelIdFromSlug(normalizePiModelSlug(profile.model)) ?? profile.model;
      explicit.set(id, profile);
    } catch {
      // A malformed legacy profile is skipped; the remaining ones still migrate.
    }
  }

  const configuredModel = optionalString(config.model);
  const executablePath = optionalString(config.inferenceServerExecutablePath);
  const modelPath = optionalString(config.inferenceServerModelPath);
  if (configuredModel && executablePath && modelPath) {
    const id = piModelIdFromSlug(normalizePiModelSlug(configuredModel)) ?? configuredModel;
    const explicitProfile = explicit.get(id);
    push(
      explicitProfile ?? {
        model: configuredModel,
        baseUrl: configBaseUrl,
        executablePath,
        modelPath,
        gpuLayers: optionalNumber(config.inferenceServerGpuLayers),
        contextSize: optionalNumber(config.inferenceServerContextSize),
        parallel: optionalNumber(config.inferenceServerParallel),
        temperature: optionalNumber(config.inferenceServerTemperature),
        topP: optionalNumber(config.inferenceServerTopP),
        topK: optionalNumber(config.inferenceServerTopK),
        minP: optionalNumber(config.inferenceServerMinP),
        flashAttention: optionalBoolean(config.inferenceServerFlashAttention),
        cacheTypeK: optionalString(config.inferenceServerCacheTypeK),
        cacheTypeV: optionalString(config.inferenceServerCacheTypeV),
        jinja: optionalBoolean(config.inferenceServerJinja),
        reasoning: optionalBoolean(config.inferenceServerReasoning),
        reasoningEffort: optionalString(config.inferenceServerReasoningEffort),
      },
    );
    explicit.delete(id);
  }
  for (const profile of explicit.values()) push(profile);

  if (profiles.length === 0) return undefined;
  return { baseUrl, apiKey, profiles };
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

/**
 * Detect the Bonsai demo layout only where the user pointed us: an explicit root
 * wins, then BONSAI_DEMO_HOME. No developer-specific paths are searched.
 */
export async function detectPiBonsaiPreset(
  options: {
    readonly isFile?: PiInferenceServerDependencies["isFile"];
    readonly environment?: NodeJS.ProcessEnv;
    readonly rootPath?: string;
  } = {},
): Promise<PiBonsaiPreset | null> {
  const isFile =
    options.isFile ??
    (async (filePath) => {
      try {
        return (await NodeFSP.stat(filePath)).isFile();
      } catch {
        return false;
      }
    });
  const environment = options.environment ?? process.env;
  const selectedRoot = options.rootPath?.trim();
  const configuredRoot = environment[PI_BONSAI_ENV_ROOT]?.trim();
  const roots = selectedRoot ? [selectedRoot] : configuredRoot ? [configuredRoot] : [];
  for (const root of roots) {
    const join = NodePath.win32.isAbsolute(root) ? NodePath.win32.join : NodePath.join;
    const executablePath = join(root, "bin", "cuda", "llama-server.exe");
    const modelPath = join(
      root,
      "models",
      "bonsai2-gguf",
      "27B",
      "Ternary-Bonsai-2-27B-PQ2_0.gguf",
    );
    if ((await isFile(executablePath)) && (await isFile(modelPath))) {
      return {
        executablePath,
        modelPath,
        baseUrl: PI_BONSAI_BASE_URL,
        model: PI_BONSAI_MODEL_ID,
      };
    }
  }
  return null;
}

/** Replace only the preset's own managed profile; other profiles keep their order. */
export function applyPiBonsaiPresetToConfig(
  config: PiInferenceConfig,
  preset: PiBonsaiPreset,
): PiInferenceConfig {
  const model = preset.model.startsWith("ft3-local/") ? preset.model : `ft3-local/${preset.model}`;
  const profile: PiInferenceProfile = {
    model,
    baseUrl: preset.baseUrl,
    executablePath: preset.executablePath,
    modelPath: preset.modelPath,
  };
  return {
    ...config,
    profiles: [...config.profiles.filter((candidate) => candidate.model !== model), profile],
  };
}

export async function savePiInferenceConfig(
  filePath: string,
  config: PiInferenceConfig,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

export function resolvePiInferenceProfile(
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

export async function probePiInferenceEndpoint(
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
  if (!health.ok) {
    return { ready: false, modelIds: [], reason: `HTTP /health returned ${health.status}.` };
  }

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

export type PiInferenceServerPhase = "stopped" | "starting" | "ready" | "failed";

export interface PiInferenceServerStatus {
  readonly instanceId: string;
  readonly phase: PiInferenceServerPhase;
  readonly ready: boolean;
  readonly endpoint: string;
  readonly model: string | undefined;
  readonly modelIds: ReadonlyArray<string>;
  readonly owned: boolean;
  readonly error: string | null;
}

interface RequestSlot {
  active: boolean;
  waiters: Array<{
    resolve: (release: () => void) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }>;
}

interface ServerOwner {
  readonly key: string;
  readonly endpoint: string;
  readonly signature: string;
  readonly profile: PiInferenceProfile;
  readonly config: PiInferenceConfig;
  readonly child: ManagedChild;
  readonly readyPromise: Promise<void>;
  readonly exitedPromise: Promise<void>;
  readonly rejectReady: (reason: Error) => void;
  readonly resolveReady: () => void;
  readonly claims: Set<string>;
  alive: boolean;
  phase: PiInferenceServerPhase;
  error: string | null;
  modelIds: ReadonlyArray<string>;
}

function endpointKey(url: URL): string {
  const normalized = new URL(url);
  if (normalized.hostname.toLowerCase() === "localhost") normalized.hostname = "127.0.0.1";
  return normalized.toString().replace(/\/$/, "");
}

function profileSignature(profile: PiInferenceProfile): string {
  return JSON.stringify({
    executablePath: NodePath.resolve(profile.executablePath),
    args: buildPiInferenceServerArgs(profile),
  });
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
  /** Register or replace the managed config for one provider instance. */
  readonly registerInstance: (
    instanceId: string,
    config: PiInferenceConfig,
    configPath?: string,
  ) => void;
  /** Config the driver registered at instance creation, or undefined when unknown. */
  readonly registeredConfig: (instanceId: string) => PiInferenceConfig | undefined;
  /** On-disk config the driver registered, the only file FT3 may rewrite for a preset. */
  readonly registeredConfigPath: (instanceId: string) => string | undefined;
  /** Auto-start on turn: start the selected profile when needed and wait for readiness. */
  readonly ensureReady: (instanceId: string, model: string | undefined) => Promise<void>;
  /** Manual UI start for the selected profile. */
  readonly start: (
    instanceId: string,
    model: string | undefined,
  ) => Promise<PiInferenceServerStatus>;
  /** Manual UI stop; only processes owned through this instance claim are killed. */
  readonly stop: (instanceId: string) => Promise<PiInferenceServerStatus>;
  /** Manual UI status, including a pre-existing external endpoint. */
  readonly status: (
    instanceId: string,
    model?: string | undefined,
  ) => Promise<PiInferenceServerStatus>;
  /** Release instance claims and kill servers that no other instance uses. */
  readonly disposeInstance: (instanceId: string) => void;
  /** Stop every FT3-owned inference server. */
  readonly shutdown: () => void;
  /** Serialize requests per endpoint, matching llama-server's default single slot. */
  readonly acquireRequestSlot: (
    baseUrl: string,
    options?: {
      readonly onQueued?: (() => void) | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ) => Promise<() => void>;
}

export function makePiInferenceServerManager(
  overrideDependencies: Partial<PiInferenceServerDependencies> = {},
): PiInferenceServerManager {
  const deps: PiInferenceServerDependencies = { ...defaultDependencies, ...overrideDependencies };
  const configs = new Map<string, PiInferenceConfig>();
  const configPaths = new Map<string, string>();
  const owners = new Map<string, ServerOwner>();
  const instanceKeys = new Map<string, Set<string>>();
  const activeKeyByInstance = new Map<string, string>();
  const startFlights = new Map<string, Promise<void>>();
  const lastFailures = new Map<string, string>();
  const requestSlots = new Map<string, RequestSlot>();

  const requireConfig = (instanceId: string): PiInferenceConfig => {
    const config = configs.get(instanceId);
    if (!config) throw new Error(`Pi inference config for ${instanceId} is not registered.`);
    return config;
  };

  const targetUrl = (config: PiInferenceConfig, profile: PiInferenceProfile | undefined) => {
    const url = parsePiLocalEndpoint(profile?.baseUrl ?? config.baseUrl);
    if (!url) throw new Error("The inference endpoint must use HTTP on a loopback address.");
    return url;
  };

  const claim = (instanceId: string, owner: ServerOwner) => {
    owner.claims.add(instanceId);
    const keys = instanceKeys.get(instanceId) ?? new Set<string>();
    keys.add(owner.key);
    instanceKeys.set(instanceId, keys);
    activeKeyByInstance.set(instanceId, owner.key);
  };

  const releaseClaim = (instanceId: string, owner: ServerOwner) => {
    owner.claims.delete(instanceId);
    const keys = instanceKeys.get(instanceId);
    keys?.delete(owner.key);
    if (keys?.size === 0) instanceKeys.delete(instanceId);
    if (activeKeyByInstance.get(instanceId) === owner.key) {
      activeKeyByInstance.delete(instanceId);
    }
  };

  const soleClaim = (owner: ServerOwner, instanceId: string): boolean =>
    owner.claims.size === 1 && owner.claims.has(instanceId);

  const stopOwner = async (owner: ServerOwner) => {
    if (!owner.alive) {
      owners.delete(owner.key);
      return;
    }
    owner.alive = false;
    owner.phase = "stopped";
    owners.delete(owner.key);
    for (const instanceId of Array.from(owner.claims)) releaseClaim(instanceId, owner);
    owner.claims.clear();
    try {
      owner.child.kill();
    } catch {
      // Process already gone; the readiness wait reports the outcome.
    }
    await Promise.race([owner.exitedPromise, deps.sleep(STOP_TIMEOUT_MS)]);
  };

  const statusForOwner = (instanceId: string, owner: ServerOwner): PiInferenceServerStatus => ({
    instanceId,
    phase: owner.phase,
    ready: owner.phase === "ready" && owner.alive,
    endpoint: owner.endpoint,
    model: owner.profile.model,
    modelIds: owner.modelIds,
    owned: true,
    error: owner.error,
  });

  const stoppedStatus = (
    instanceId: string,
    config: PiInferenceConfig,
    profile?: PiInferenceProfile | undefined,
    error: string | null = null,
  ): PiInferenceServerStatus => ({
    instanceId,
    phase: error ? "failed" : "stopped",
    ready: false,
    endpoint: profile?.baseUrl ?? config.baseUrl,
    model: profile?.model,
    modelIds: [],
    owned: false,
    error,
  });

  const spawnOwner = async (
    instanceId: string,
    config: PiInferenceConfig,
    profile: PiInferenceProfile,
    key: string,
    signature: string,
  ): Promise<ServerOwner> => {
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
    let resolveExited = () => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const exitedPromise = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    void readyPromise.catch(() => undefined);
    const child = deps.spawn(executable, args, {
      cwd: NodePath.dirname(executable),
      windowsHide: true,
      stdio: "ignore",
    });
    const owner: ServerOwner = {
      key,
      endpoint: profile.baseUrl,
      signature,
      profile,
      config,
      child,
      readyPromise,
      exitedPromise,
      rejectReady,
      resolveReady,
      claims: new Set([instanceId]),
      alive: true,
      phase: "starting",
      error: null,
      modelIds: [],
    };
    owners.set(key, owner);
    activeKeyByInstance.set(instanceId, key);
    const keys = instanceKeys.get(instanceId) ?? new Set<string>();
    keys.add(key);
    instanceKeys.set(instanceId, keys);
    child.on("error", (cause: unknown) => {
      owner.alive = false;
      owner.phase = "failed";
      owner.error = `FT3 could not start the configured llama-server executable (${String((cause as { code?: unknown })?.code ?? cause)}).`;
      owner.rejectReady(new Error(owner.error));
      resolveExited();
    });
    child.on("close", (code: number | null) => {
      owner.alive = false;
      if (owner.phase !== "stopped") owner.phase = "failed";
      const error = `The FT3-owned inference process exited before readiness (code ${code === null ? "unknown" : code}).`;
      owner.rejectReady(new Error(error));
      resolveExited();
    });
    void watchReadiness(owner);
    return owner;
  };

  const watchReadiness = async (owner: ServerOwner) => {
    const expectedModelId = piModelIdFromSlug(owner.profile.model);
    const deadline = deps.now() + READINESS_TIMEOUT_MS;
    let reason = "The inference endpoint did not become ready.";
    while (owner.alive && deps.now() < deadline) {
      const probe = await probePiInferenceEndpoint(
        { baseUrl: owner.profile.baseUrl, apiKey: owner.config.apiKey },
        deps.fetch,
        expectedModelId,
      );
      if (probe.ready) {
        owner.phase = "ready";
        owner.modelIds = probe.modelIds;
        owner.resolveReady();
        return;
      }
      reason = probe.reason;
      owner.modelIds = probe.modelIds;
      await deps.sleep(PROBE_INTERVAL_MS);
    }
    if (owner.alive) {
      owner.alive = false;
      owner.phase = "failed";
      owner.error = reason;
      try {
        owner.child.kill();
      } catch {
        // Keep the readiness failure as the reported cause.
      }
    }
    owner.rejectReady(new Error(reason));
  };

  const launch = async (
    instanceId: string,
    config: PiInferenceConfig,
    profile: PiInferenceProfile,
    key: string,
    signature: string,
  ): Promise<ServerOwner> => {
    const inFlight = startFlights.get(key);
    if (inFlight) {
      await inFlight;
      const owner = owners.get(key);
      if (!owner?.alive) throw new Error("The concurrent inference server start did not survive.");
      if (owner.signature !== signature) {
        throw new Error(
          "A different Pi model/server profile is already starting at this endpoint; stop it first.",
        );
      }
      claim(instanceId, owner);
      await owner.readyPromise;
      return owner;
    }
    let settle: () => void = () => {};
    let fail: (reason: Error) => void = () => {};
    const flight = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    void flight.catch(() => undefined);
    startFlights.set(key, flight);
    void (async () => {
      try {
        const owner = await spawnOwner(instanceId, config, profile, key, signature);
        await owner.readyPromise;
        settle();
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        startFlights.delete(key);
      }
    })();
    await flight;
    const owner = owners.get(key);
    if (!owner?.alive) throw new Error("The inference server exited immediately after start.");
    claim(instanceId, owner);
    return owner;
  };

  const ensureReady = async (instanceId: string, model: string | undefined): Promise<void> => {
    const config = requireConfig(instanceId);
    const profile = resolvePiInferenceProfile(config, model);
    if (!profile) return;
    const url = targetUrl(config, profile);
    const key = endpointKey(url);
    const signature = profileSignature(profile);
    const expectedModelId = piModelIdFromSlug(profile.model);
    try {
      const probe = await probePiInferenceEndpoint(
        { baseUrl: profile.baseUrl, apiKey: config.apiKey },
        deps.fetch,
        expectedModelId,
      );
      if (probe.ready) {
        const owner = owners.get(key);
        if (owner?.alive) claim(instanceId, owner);
        lastFailures.delete(instanceId);
        return;
      }

      const existing = owners.get(key);
      if (existing?.alive) {
        if (existing.signature === signature) {
          claim(instanceId, existing);
          if (existing.phase === "ready") {
            throw new Error(
              "The FT3-owned inference server was ready but stopped responding; restart the instance.",
            );
          }
          await existing.readyPromise;
          lastFailures.delete(instanceId);
          return;
        }
        if (!soleClaim(existing, instanceId)) {
          throw new Error(
            "The selected model needs a different server profile, but this endpoint is shared with another Pi instance. Stop or move that instance first.",
          );
        }
        await stopOwner(existing);
      } else if (probe.modelIds.length > 0) {
        throw new Error(
          `The endpoint is already serving a different model (${probe.modelIds.join(", ")}); stop it first.`,
        );
      }

      await launch(instanceId, config, profile, key, signature);
      lastFailures.delete(instanceId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      lastFailures.set(instanceId, message);
      throw cause;
    }
  };

  const status = async (
    instanceId: string,
    model?: string | undefined,
  ): Promise<PiInferenceServerStatus> => {
    const config = requireConfig(instanceId);
    const profile = resolvePiInferenceProfile(config, model);
    const key = activeKeyByInstance.get(instanceId);
    const owner = key ? owners.get(key) : undefined;
    if (owner?.alive) return statusForOwner(instanceId, owner);
    targetUrl(config, profile);
    const probe = await probePiInferenceEndpoint(
      { baseUrl: profile?.baseUrl ?? config.baseUrl, apiKey: config.apiKey },
      deps.fetch,
      piModelIdFromSlug(profile?.model),
    );
    const failure = lastFailures.get(instanceId) ?? null;
    if (probe.ready) {
      return {
        instanceId,
        phase: "ready",
        ready: true,
        endpoint: profile?.baseUrl ?? config.baseUrl,
        model: profile?.model,
        modelIds: probe.modelIds,
        owned: false,
        error: null,
      };
    }
    return {
      instanceId,
      phase: failure ? "failed" : "stopped",
      ready: false,
      endpoint: profile?.baseUrl ?? config.baseUrl,
      model: profile?.model,
      modelIds: probe.modelIds,
      owned: false,
      error: failure ?? (probe.modelIds.length > 0 ? probe.reason : null),
    };
  };

  const start = async (
    instanceId: string,
    model: string | undefined,
  ): Promise<PiInferenceServerStatus> => {
    const config = requireConfig(instanceId);
    const profile = resolvePiInferenceProfile(config, model);
    if (!profile) throw new Error("The selected model has no managed inference profile.");
    await ensureReady(instanceId, model);
    return status(instanceId, model);
  };

  const stop = async (instanceId: string): Promise<PiInferenceServerStatus> => {
    const config = requireConfig(instanceId);
    const activeKey = activeKeyByInstance.get(instanceId);
    const keys = [...(instanceKeys.get(instanceId) ?? [])];
    for (const key of keys) {
      const owner = owners.get(key);
      if (!owner) continue;
      releaseClaim(instanceId, owner);
      if (owner.claims.size === 0) await stopOwner(owner);
    }
    instanceKeys.delete(instanceId);
    activeKeyByInstance.delete(instanceId);
    lastFailures.delete(instanceId);
    const owner = activeKey ? owners.get(activeKey) : undefined;
    return owner
      ? statusForOwner(instanceId, owner)
      : stoppedStatus(instanceId, config, resolvePiInferenceProfile(config, undefined));
  };

  const disposeInstance = (instanceId: string): void => {
    const keys = [...(instanceKeys.get(instanceId) ?? [])];
    for (const key of keys) {
      const owner = owners.get(key);
      if (!owner) continue;
      releaseClaim(instanceId, owner);
      if (owner.claims.size > 0) continue;
      owner.alive = false;
      owner.phase = "stopped";
      owners.delete(key);
      try {
        owner.child.kill();
      } catch {
        // The process is already gone.
      }
    }
    instanceKeys.delete(instanceId);
    activeKeyByInstance.delete(instanceId);
    lastFailures.delete(instanceId);
  };

  const shutdown = (): void => {
    for (const owner of owners.values()) {
      owner.alive = false;
      owner.phase = "stopped";
      try {
        owner.child.kill();
      } catch {
        // The process is already gone.
      }
    }
    owners.clear();
    instanceKeys.clear();
    activeKeyByInstance.clear();
  };

  const makeRelease = (slot: RequestSlot, key: string) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (slot.waiters.length > 0) {
        const next = slot.waiters.shift()!;
        if (next.signal?.aborted) continue;
        if (next.abort) next.signal?.removeEventListener("abort", next.abort);
        next.resolve(makeRelease(slot, key));
        return;
      }
      slot.active = false;
      requestSlots.delete(key);
    };
  };

  const acquireRequestSlot = (
    baseUrl: string,
    options: {
      readonly onQueued?: (() => void) | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<() => void> => {
    const url = parsePiLocalEndpoint(baseUrl);
    if (!url) return Promise.resolve(() => undefined);
    const key = endpointKey(url);
    let slot = requestSlots.get(key);
    if (!slot) {
      slot = { active: false, waiters: [] };
      requestSlots.set(key, slot);
    }
    if (!slot.active) {
      slot.active = true;
      return Promise.resolve(makeRelease(slot, key));
    }
    options.onQueued?.();
    return new Promise<() => void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("Inference request was interrupted while queued."));
        return;
      }
      const waiter: (typeof slot.waiters)[number] = { resolve };
      if (options.signal) waiter.signal = options.signal;
      if (options.signal) {
        waiter.abort = () => {
          slot!.waiters = slot!.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error("Inference request was interrupted while queued."));
        };
        options.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      slot!.waiters.push(waiter);
    });
  };

  return {
    registerInstance: (instanceId, config, configPath) => {
      configs.set(instanceId, config);
      if (configPath !== undefined) configPaths.set(instanceId, configPath);
    },
    registeredConfig: (instanceId) => configs.get(instanceId),
    registeredConfigPath: (instanceId) => configPaths.get(instanceId),
    ensureReady,
    start,
    stop,
    status,
    disposeInstance,
    shutdown,
    acquireRequestSlot,
  };
}

/** Process-wide manager so every provider instance sees the same endpoint claims. */
export const piInferenceServerManager = makePiInferenceServerManager();
