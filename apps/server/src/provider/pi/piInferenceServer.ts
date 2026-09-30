// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - must own the exact native process handle for safe stop and an abortable HTTP-readiness timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PiBonsaiPreset,
  PiInferenceServerStatus,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { parsePiLocalEndpoint, piModelIdFromSlug } from "./piAgentDir.ts";
export { parsePiLocalEndpoint } from "./piAgentDir.ts";

const READINESS_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;
export const PI_BONSAI_MODEL_ID = "bonsai-2-27b";
const PROBE_INTERVAL_MS = 1_000;
const READINESS_PROGRESS_AT_MS = [
  3_000, 15_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000, 480_000,
  540_000,
];

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
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface PiInferenceActivity {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly source: "manual" | "automatic";
  readonly emit: (message: string) => Promise<void>;
}

export interface PiBonsaiPresetCandidate {
  readonly executablePath: string;
  readonly modelPath: string;
  readonly baseUrl: string;
  readonly model: PiBonsaiPreset["model"];
}

type ProbeResult =
  | { readonly ready: true; readonly modelIds: ReadonlyArray<string> }
  | { readonly ready: false; readonly modelIds: ReadonlyArray<string>; readonly reason: string };

interface ServerOwner {
  readonly key: string;
  readonly endpoint: string;
  readonly executablePath: string;
  readonly launchArgs: ReadonlyArray<string>;
  readonly child: ManagedChild;
  readonly controller: AbortController;
  readonly closed: Promise<void>;
  resolveClosed: () => void;
  alive: boolean;
  stopping: boolean;
  phase: PiInferenceServerStatus["phase"];
  progress: string | null;
  error: string | null;
  modelIds: ReadonlyArray<string>;
  startedAt: number;
  readyPromise: Promise<void>;
  rejectReady: (reason: Error) => void;
  resolveReady: () => void;
  readonly activities: Map<string, PiInferenceActivity>;
  notifiedTerminal: boolean;
}

interface LaunchingState {
  progress: string;
}

/** Expose only the origin: credentials, query, fragment, and path can all hold secrets. */
export function sanitizePiBaseUrlForDisplay(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "(empty)";
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return "(invalid endpoint)";
  }
}

function endpointKey(url: URL): string {
  const normalized = new URL(url);
  // localhost and the IPv4 loopback alias share one owner. Keep ::1 as a
  // separate bind address so one process does not claim the other socket.
  if (normalized.hostname.toLowerCase() === "localhost") {
    normalized.hostname = "127.0.0.1";
  }
  return normalized.toString().replace(/\/$/, "");
}

function launchSignature(settings: PiSettings): string {
  const url = parsePiLocalEndpoint(settings.baseUrl);
  let args: ReadonlyArray<string> | null = null;
  try {
    args = buildPiInferenceServerArgs(settings);
  } catch {
    // An unconfigured external Pi endpoint still needs a stable signature so
    // a different selected model cannot join its in-flight status request.
  }
  return JSON.stringify({
    endpoint: url ? endpointKey(url) : settings.baseUrl.trim(),
    executable: NodePath.resolve((settings.inferenceServerExecutablePath ?? "").trim()),
    modelPath: NodePath.resolve((settings.inferenceServerModelPath ?? "").trim()),
    modelId: piModelIdFromSlug(settings.model) ?? settings.model,
    args,
  });
}

function ownerMatchesSettings(owner: ServerOwner, settings: PiSettings): boolean {
  let args: ReadonlyArray<string>;
  try {
    args = buildPiInferenceServerArgs(settings);
  } catch {
    return false;
  }
  return (
    owner.executablePath ===
      NodePath.resolve((settings.inferenceServerExecutablePath ?? "").trim()) &&
    JSON.stringify(owner.launchArgs) === JSON.stringify(args)
  );
}

export function hasPiManagedInferenceConfig(settings: PiSettings): boolean {
  return (
    (settings.inferenceServerExecutablePath ?? "").trim().length > 0 &&
    (settings.inferenceServerModelPath ?? "").trim().length > 0 &&
    parsePiLocalEndpoint(settings.baseUrl) !== undefined
  );
}

/** Resolve only an exact selected-model profile; legacy fields belong to settings.model. */
export function piInferenceSettingsForModel(
  settings: PiSettings,
  selectedModel?: string,
  options: { readonly requireProfile?: boolean } = {},
): PiSettings {
  if (!selectedModel) return settings;
  const selectedId = piModelIdFromSlug(selectedModel) ?? selectedModel;
  const profile = settings.inferenceServerProfiles.find(
    (entry) =>
      entry.model === selectedModel ||
      (piModelIdFromSlug(entry.model) ?? entry.model) === selectedId,
  );
  const configuredId = piModelIdFromSlug(settings.model) ?? settings.model;
  const isKnownBonsaiSize = /^bonsai-2-(?:8b|27b)$/i.test(selectedId);
  const legacyManagedConfig = Boolean(
    settings.inferenceServerExecutablePath.trim() && settings.inferenceServerModelPath.trim(),
  );
  if (!profile && options.requireProfile) {
    throw new Error(
      `Configure a managed llama-server profile for the selected Pi model (${selectedId}).`,
    );
  }
  if (!profile && selectedId === configuredId && !(isKnownBonsaiSize && legacyManagedConfig)) {
    return settings;
  }
  if (
    !profile ||
    !profile.executablePath.trim() ||
    !profile.modelPath.trim() ||
    !profile.baseUrl.trim()
  ) {
    throw new Error(
      `Configure a managed llama-server profile for the selected Pi model (${selectedId}).`,
    );
  }
  return {
    ...settings,
    model: selectedModel,
    baseUrl: profile.baseUrl,
    inferenceServerExecutablePath: profile.executablePath,
    inferenceServerModelPath: profile.modelPath,
  };
}

/** The small, fixed Bonsai 2 profile; no shell is involved in launching it. */
export function buildPiInferenceServerArgs(settings: PiSettings): ReadonlyArray<string> {
  const url = parsePiLocalEndpoint(settings.baseUrl);
  if (!url) throw new Error("The inference endpoint must use HTTP on a loopback address.");
  if (!(settings.inferenceServerModelPath ?? "").trim()) {
    throw new Error("Configure the GGUF model file in Pi settings.");
  }
  const port = url.port || "80";
  const host = url.hostname.toLowerCase() === "[::1]" ? "::1" : "127.0.0.1";
  const modelId = piModelIdFromSlug(settings.model);
  const gpuLayers = settings.inferenceServerGpuLayers ?? 48;
  const contextSize = settings.inferenceServerContextSize ?? 81_920;
  const parallel = settings.inferenceServerParallel ?? 1;
  const temperature = settings.inferenceServerTemperature ?? 1;
  const topP = settings.inferenceServerTopP ?? 0.95;
  const topK = settings.inferenceServerTopK ?? 20;
  const minP = settings.inferenceServerMinP ?? 0.05;
  if (!Number.isInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > 999)
    throw new Error("GPU layers must be between 0 and 999.");
  if (!Number.isInteger(contextSize) || contextSize < 512 || contextSize > 1_048_576)
    throw new Error("Context size must be between 512 and 1048576 tokens.");
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 64)
    throw new Error("Parallel slots must be between 1 and 64.");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error("Temperature must be between 0 and 2.");
  if (!Number.isFinite(topP) || topP < 0 || topP > 1)
    throw new Error("Top-p must be between 0 and 1.");
  if (!Number.isInteger(topK) || topK < 0 || topK > 1000)
    throw new Error("Top-k must be between 0 and 1000.");
  if (!Number.isFinite(minP) || minP < 0 || minP > 1)
    throw new Error("Min-p must be between 0 and 1.");
  return [
    "-m",
    NodePath.resolve((settings.inferenceServerModelPath ?? "").trim()),
    ...(modelId ? ["--alias", modelId] : []),
    "--host",
    host,
    "--port",
    port,
    "-ngl",
    String(gpuLayers),
    "-fa",
    settings.inferenceServerFlashAttention === false ? "off" : "on",
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
    ...(settings.inferenceServerJinja === false ? [] : ["--jinja"]),
    "--cache-type-k",
    settings.inferenceServerCacheTypeK ?? "q4_0",
    "--cache-type-v",
    settings.inferenceServerCacheTypeV ?? "q4_0",
    "--reasoning",
    settings.inferenceServerReasoning === false ? "off" : "on",
    "--reasoning-effort",
    settings.inferenceServerReasoningEffort ?? "medium",
  ];
}

function asStatus(
  instanceId: ProviderInstanceId,
  settings: PiSettings,
  owner: ServerOwner | undefined,
  input: {
    readonly phase: PiInferenceServerStatus["phase"];
    readonly ownerKind: PiInferenceServerStatus["owner"];
    readonly ready: boolean;
    readonly progress: string | null;
    readonly error: string | null;
    readonly modelIds: ReadonlyArray<string>;
    readonly orphanedManagedEndpoint?: string | null | undefined;
    readonly usedByOtherInstances?: boolean | undefined;
  },
): PiInferenceServerStatus {
  const url = parsePiLocalEndpoint(settings.baseUrl);
  const isOwned = owner?.alive === true && input.ownerKind === "ft3";
  let pendingRestart = false;
  if (isOwned && owner) {
    try {
      pendingRestart =
        NodePath.resolve((settings.inferenceServerExecutablePath ?? "").trim()) !==
          owner.executablePath ||
        JSON.stringify(buildPiInferenceServerArgs(settings)) !== JSON.stringify(owner.launchArgs);
    } catch {
      pendingRestart = true;
    }
  }
  return {
    instanceId,
    endpoint: sanitizePiBaseUrlForDisplay(settings.baseUrl),
    local: url !== undefined,
    phase: input.phase,
    owner: input.ownerKind,
    ready: input.ready,
    canStart:
      url !== undefined &&
      input.ownerKind !== "external" &&
      (hasPiManagedInferenceConfig(settings) || input.ready),
    canStop: isOwned && input.usedByOtherInstances !== true,
    pendingRestart,
    orphanedManagedEndpoint: input.orphanedManagedEndpoint ?? null,
    usedByOtherInstances: input.usedByOtherInstances ?? false,
    progress: input.progress,
    error: input.error,
    modelIds: [...input.modelIds],
  };
}

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

export async function probePiInferenceEndpoint(
  settings: Pick<PiSettings, "baseUrl" | "apiKey">,
  fetcher: typeof fetch = fetch,
  expectedModelId?: string,
): Promise<ProbeResult> {
  const base = parsePiLocalEndpoint(settings.baseUrl);
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
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    return {
      ready: false,
      modelIds: [],
      reason: timedOut
        ? "Timed out waiting for HTTP /health."
        : "HTTP /health is not responding yet.",
    };
  }
  if (!health.ok) {
    return {
      ready: false,
      modelIds: [],
      reason: `HTTP /health returned ${health.status}.`,
    };
  }

  const modelsUrl = new URL(base);
  modelsUrl.pathname = `${base.pathname.replace(/\/+$/, "")}/models`;
  const apiKey = settings.apiKey.trim();
  let modelsResponse: Response;
  try {
    modelsResponse = await fetcher(modelsUrl, {
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
      ...(apiKey.length > 0 ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    return {
      ready: false,
      modelIds: [],
      reason: timedOut
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
    return {
      ready: false,
      modelIds: [],
      reason: "HTTP /v1/models returned invalid JSON.",
    };
  }
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
    return {
      ready: false,
      modelIds: [],
      reason: "HTTP /v1/models did not contain a data array.",
    };
  }
  const modelIds = [
    ...new Set(
      body.data.flatMap((entry: unknown) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("id" in entry) ||
          typeof entry.id !== "string" ||
          entry.id.trim().length === 0
        ) {
          return [];
        }
        const safeId = entry.id
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
          .trim()
          .slice(0, 160);
        return safeId.length > 0 ? [safeId] : [];
      }),
    ),
  ].slice(0, 32);
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

function makeReadyDeferred(): Pick<ServerOwner, "readyPromise" | "resolveReady" | "rejectReady"> {
  let resolveReady = () => {};
  let rejectReady = (_reason: Error) => {};
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Manual Start observes state through getStatus; ensure the background
  // readiness promise can fail without creating an unhandled rejection.
  void readyPromise.catch(() => undefined);
  return { readyPromise, resolveReady, rejectReady };
}

function configuredPathIssue(settings: PiSettings): string | undefined {
  const executable = (settings.inferenceServerExecutablePath ?? "").trim();
  const model = (settings.inferenceServerModelPath ?? "").trim();
  if (!executable || !model) {
    return "Configure both the llama-server executable and GGUF model file in Pi settings.";
  }
  if (/\.ps1$/i.test(executable)) {
    return "Configure the direct llama-server executable; PowerShell launchers are not executed by FT3.";
  }
  return undefined;
}

export function makePiInferenceServerManager(
  dependencies: Partial<PiInferenceServerDependencies> = {},
) {
  const deps: PiInferenceServerDependencies = {
    spawn: (command, args, options) =>
      NodeChildProcess.spawn(command, [...args], {
        cwd: options.cwd,
        windowsHide: options.windowsHide,
        stdio: options.stdio,
        shell: false,
      }),
    isFile: async (filePath) => {
      try {
        await NodeFSP.access(filePath);
        return (await NodeFSP.stat(filePath)).isFile();
      } catch {
        return false;
      }
    },
    fetch,
    now: Date.now,
    sleep: (milliseconds, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, milliseconds);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ...dependencies,
  };
  const owners = new Map<string, ServerOwner>();
  const instanceOwnerKeys = new Map<ProviderInstanceId, Set<string>>();
  const activeOwnerKeyByInstance = new Map<ProviderInstanceId, string>();
  const activeInstancesByOwner = new Map<string, Set<ProviderInstanceId>>();
  const startFlights = new Map<string, Promise<PiInferenceServerStatus>>();
  const startFlightSignatures = new Map<string, string>();
  const launching = new Map<string, LaunchingState>();
  const lastFailures = new Map<string, string>();
  const pendingActivities = new Map<string, Map<string, PiInferenceActivity>>();
  const requestSlots = new Map<
    string,
    {
      active: boolean;
      waiters: Array<{
        resolve: (release: () => void) => void;
        signal?: AbortSignal;
        abort?: () => void;
      }>;
    }
  >();
  const probeFlights = new Map<string, Promise<ProbeResult>>();

  const releaseActiveOwnerForInstance = (instanceId: ProviderInstanceId): void => {
    const previousKey = activeOwnerKeyByInstance.get(instanceId);
    if (previousKey === undefined) return;
    activeOwnerKeyByInstance.delete(instanceId);
    const instances = activeInstancesByOwner.get(previousKey);
    instances?.delete(instanceId);
    if (instances?.size === 0) activeInstancesByOwner.delete(previousKey);
  };

  const rememberOwnerForInstance = (instanceId: ProviderInstanceId, owner: ServerOwner): void => {
    const previousKey = activeOwnerKeyByInstance.get(instanceId);
    if (previousKey !== owner.key) releaseActiveOwnerForInstance(instanceId);
    activeOwnerKeyByInstance.set(instanceId, owner.key);
    const activeInstances = activeInstancesByOwner.get(owner.key) ?? new Set<ProviderInstanceId>();
    activeInstances.add(instanceId);
    activeInstancesByOwner.set(owner.key, activeInstances);
    const keys = instanceOwnerKeys.get(instanceId) ?? new Set<string>();
    keys.delete(owner.key);
    keys.add(owner.key);
    instanceOwnerKeys.set(instanceId, keys);
  };

  const observeInstanceEndpoint = (
    instanceId: ProviderInstanceId,
    key: string | undefined,
  ): void => {
    const owner = key ? owners.get(key) : undefined;
    if (owner?.alive) rememberOwnerForInstance(instanceId, owner);
    else releaseActiveOwnerForInstance(instanceId);
  };

  const hasOtherActiveInstances = (instanceId: ProviderInstanceId, owner: ServerOwner): boolean =>
    [...(activeInstancesByOwner.get(owner.key) ?? [])].some((activeId) => activeId !== instanceId);

  const forgetOwnerAssociations = (owner: ServerOwner): void => {
    activeInstancesByOwner.delete(owner.key);
    for (const [instanceId, key] of activeOwnerKeyByInstance) {
      if (key === owner.key) activeOwnerKeyByInstance.delete(instanceId);
    }
    for (const [instanceId, keys] of instanceOwnerKeys) {
      keys.delete(owner.key);
      if (keys.size === 0) instanceOwnerKeys.delete(instanceId);
    }
  };

  const findOrphanedOwner = (
    instanceId: ProviderInstanceId,
    currentKey?: string | undefined,
  ): ServerOwner | undefined => {
    const keys = instanceOwnerKeys.get(instanceId);
    if (!keys) return undefined;
    for (const key of [...keys].toReversed()) {
      if (key === currentKey) continue;
      const owner = owners.get(key);
      if (owner?.alive) {
        const activeInstances = activeInstancesByOwner.get(key);
        if ([...(activeInstances ?? [])].every((activeId) => activeId === instanceId)) return owner;
        continue;
      }
      keys.delete(key);
    }
    if (keys.size === 0) instanceOwnerKeys.delete(instanceId);
    return undefined;
  };

  const orphanedEndpoint = (
    instanceId: ProviderInstanceId,
    currentKey?: string | undefined,
  ): string | null => {
    const owner = findOrphanedOwner(instanceId, currentKey);
    return owner ? sanitizePiBaseUrlForDisplay(owner.endpoint) : null;
  };

  const probe = (settings: PiSettings): Promise<ProbeResult> => {
    const url = parsePiLocalEndpoint(settings.baseUrl);
    if (!url) return probePiInferenceEndpoint(settings, deps.fetch);
    const expected = piModelIdFromSlug(settings.model) ?? undefined;
    const key = `${endpointKey(url)}:${expected ?? "*"}`;
    const existing = probeFlights.get(key);
    if (existing) return existing;
    const flight = probePiInferenceEndpoint(settings, deps.fetch, expected).finally(() => {
      if (probeFlights.get(key) === flight) probeFlights.delete(key);
    });
    probeFlights.set(key, flight);
    return flight;
  };

  const emit = async (entry: ServerOwner, message: string): Promise<void> => {
    await Promise.allSettled(
      [...entry.activities.values()].map((activity) => activity.emit(message)),
    );
  };

  const addActivity = (entry: ServerOwner, activity?: PiInferenceActivity): void => {
    if (activity) entry.activities.set(activity.key, activity);
  };

  const statusForOwner = (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
    owner: ServerOwner,
  ) => {
    const expectedModelId = piModelIdFromSlug(settings.model);
    const wrongModel =
      !ownerMatchesSettings(owner, settings) ||
      Boolean(expectedModelId && !owner.modelIds.includes(expectedModelId));
    return asStatus(instanceId, settings, owner, {
      phase: owner.phase,
      ownerKind: owner.alive ? "ft3" : "none",
      ready: owner.phase === "ready" && owner.alive && !owner.stopping && !wrongModel,
      progress: wrongModel ? null : owner.progress,
      error: wrongModel
        ? `The endpoint is running a different model/profile (${owner.modelIds.join(", ") || "identity not verified"}); stop it, then Start to launch the selected model.`
        : owner.error,
      modelIds: owner.modelIds,
      orphanedManagedEndpoint: orphanedEndpoint(instanceId, owner.key),
      usedByOtherInstances: hasOtherActiveInstances(instanceId, owner),
    });
  };

  const settleReady = async (entry: ServerOwner, result: ProbeResult): Promise<void> => {
    entry.phase = "ready";
    entry.progress = "Endpoint and model catalog are ready.";
    entry.error = null;
    entry.modelIds = result.modelIds;
    lastFailures.delete(entry.key);
    if (!entry.notifiedTerminal) {
      entry.notifiedTerminal = true;
      await emit(
        entry,
        `Ready: /health passed and /v1/models lists ${result.modelIds.join(", ")}.`,
      );
    }
    entry.resolveReady();
  };

  const settleFailure = async (entry: ServerOwner, reason: string): Promise<void> => {
    entry.phase = "failed";
    entry.progress = null;
    entry.error = reason;
    lastFailures.set(entry.key, reason);
    if (!entry.notifiedTerminal) {
      entry.notifiedTerminal = true;
      await emit(entry, `Inference server failed: ${reason}`);
    }
    entry.rejectReady(new Error(reason));
    entry.activities.clear();
  };

  const watchReadiness = async (entry: ServerOwner, settings: PiSettings): Promise<void> => {
    entry.startedAt = deps.now();
    const deadline = entry.startedAt + READINESS_TIMEOUT_MS;
    let nextProgress = 0;
    entry.notifiedTerminal = false;
    entry.phase = "starting";
    entry.progress = "Checking local /health and /v1/models.";
    entry.error = null;
    const readyDeferred = makeReadyDeferred();
    entry.readyPromise = readyDeferred.readyPromise;
    entry.resolveReady = readyDeferred.resolveReady;
    entry.rejectReady = readyDeferred.rejectReady;

    while (!entry.controller.signal.aborted && entry.alive) {
      const checkedAt = deps.now();
      const result = await probe(settings);
      if (entry.controller.signal.aborted) break;
      if (!entry.alive) break;
      if (result.ready) {
        await settleReady(entry, result);
        return;
      }
      entry.phase = "running";
      entry.progress = result.reason;
      entry.error = null;
      const elapsed = checkedAt - entry.startedAt;
      if (elapsed >= READINESS_TIMEOUT_MS) {
        await settleFailure(
          entry,
          `Readiness timed out after ${Math.round(READINESS_TIMEOUT_MS / 1000)}s: ${result.reason}`,
        );
        return;
      }
      if (elapsed >= (READINESS_PROGRESS_AT_MS[nextProgress] ?? READINESS_TIMEOUT_MS)) {
        const elapsedSeconds = Math.max(1, Math.round(elapsed / 1000));
        await emit(entry, `Still waiting (${elapsedSeconds}s): ${result.reason}`);
        nextProgress += 1;
      }
      try {
        await deps.sleep(
          Math.min(PROBE_INTERVAL_MS, deadline - deps.now()),
          entry.controller.signal,
        );
      } catch {
        break;
      }
    }

    if (!entry.alive && !entry.stopping) {
      await settleFailure(
        entry,
        "The FT3-owned inference process exited before the endpoint became ready.",
      );
    } else if (entry.stopping) {
      entry.rejectReady(new Error("The FT3-owned inference server was stopped."));
    }
  };

  const validateFiles = async (settings: PiSettings): Promise<string | undefined> => {
    const executable = (settings.inferenceServerExecutablePath ?? "").trim();
    const model = (settings.inferenceServerModelPath ?? "").trim();
    const issue = configuredPathIssue(settings);
    if (issue) return issue;
    if (!(await deps.isFile(executable)))
      return "The configured llama-server executable was not found as a file.";
    if (!(await deps.isFile(model)))
      return "The configured GGUF model file was not found as a file.";
    return undefined;
  };

  const createOwner = async (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
    activities: ReadonlyArray<PiInferenceActivity>,
  ): Promise<ServerOwner> => {
    const url = parsePiLocalEndpoint(settings.baseUrl);
    if (!url) throw new Error("The inference endpoint must use HTTP on a loopback address.");
    const missing = await validateFiles(settings);
    if (missing) throw new Error(missing);
    const executable = NodePath.resolve(settings.inferenceServerExecutablePath.trim());
    const args = buildPiInferenceServerArgs(settings);
    const closeDeferred = (() => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const child = deps.spawn(executable, args, {
      cwd: NodePath.dirname(executable),
      windowsHide: true,
      stdio: "ignore",
    });
    const ready = makeReadyDeferred();
    const owner: ServerOwner = {
      key: endpointKey(url),
      endpoint: endpointKey(url),
      executablePath: executable,
      launchArgs: args,
      child,
      controller: new AbortController(),
      closed: closeDeferred.promise,
      resolveClosed: closeDeferred.resolve,
      alive: true,
      stopping: false,
      phase: "starting",
      progress: "Starting configured llama-server process.",
      error: null,
      modelIds: [],
      startedAt: deps.now(),
      readyPromise: ready.readyPromise,
      rejectReady: ready.rejectReady,
      resolveReady: ready.resolveReady,
      activities: new Map(),
      notifiedTerminal: false,
    };
    for (const activity of activities) addActivity(owner, activity);
    child.on("error", (cause: unknown) => {
      owner.alive = false;
      owner.resolveClosed();
      forgetOwnerAssociations(owner);
      const code =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : undefined;
      void settleFailure(
        owner,
        `FT3 could not start the configured llama-server executable${code ? ` (${code}).` : "."}`,
      );
    });
    child.on("close", (code) => {
      owner.alive = false;
      owner.resolveClosed();
      forgetOwnerAssociations(owner);
      if (owner.stopping) {
        owner.phase = "stopped";
        owner.progress = null;
        owner.error = null;
        owner.modelIds = [];
        owner.rejectReady(new Error("The FT3-owned inference server was stopped."));
      } else if (owner.phase !== "ready") {
        void settleFailure(
          owner,
          `The FT3-owned inference process exited before readiness (code ${code === null ? "unknown" : code}).`,
        );
      } else {
        owner.phase = "failed";
        owner.progress = null;
        owner.error = `The FT3-owned inference process exited (code ${code === null ? "unknown" : code}).`;
        lastFailures.set(owner.key, owner.error);
        void emit(owner, `Inference server failed: ${owner.error}`).finally(() => {
          owner.activities.clear();
        });
      }
    });
    owners.set(owner.key, owner);
    rememberOwnerForInstance(instanceId, owner);
    await emit(owner, "FT3 created one llama-server process; checking /health and /v1/models.");
    void watchReadiness(owner, settings);
    return owner;
  };

  const start = async (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
    activity?: PiInferenceActivity,
  ): Promise<PiInferenceServerStatus> => {
    const url = parsePiLocalEndpoint(settings.baseUrl);
    if (!url) {
      observeInstanceEndpoint(instanceId, undefined);
      return asStatus(instanceId, settings, undefined, {
        phase: "stopped",
        ownerKind: "none",
        ready: false,
        progress: null,
        error: "Only local HTTP loopback endpoints can be managed.",
        modelIds: [],
        orphanedManagedEndpoint: orphanedEndpoint(instanceId),
      });
    }
    const key = endpointKey(url);
    const existing = owners.get(key);
    if (existing?.alive) {
      const requestedArgs = (() => {
        try {
          return JSON.stringify(buildPiInferenceServerArgs(settings));
        } catch {
          return "";
        }
      })();
      if (
        existing.executablePath !==
          NodePath.resolve((settings.inferenceServerExecutablePath ?? "").trim()) ||
        JSON.stringify(existing.launchArgs) !== requestedArgs
      ) {
        const shared = hasOtherActiveInstances(instanceId, existing);
        releaseActiveOwnerForInstance(instanceId);
        const reason = shared
          ? "The selected model needs a different server profile, but this endpoint is shared with another Pi instance. Stop or move that instance first."
          : `The endpoint is still running ${existing.modelIds.join(", ") || "another model"}. Stop it, then Start to launch the selected model.`;
        return asStatus(instanceId, settings, existing, {
          phase: existing.phase,
          ownerKind: "ft3",
          ready: false,
          progress: null,
          error: reason,
          modelIds: existing.modelIds,
          usedByOtherInstances: shared,
        });
      }
      rememberOwnerForInstance(instanceId, existing);
      if (existing.stopping) return statusForOwner(instanceId, settings, existing);
      const alreadyObserved = activity ? existing.activities.has(activity.key) : false;
      addActivity(existing, activity);
      if (existing.phase === "ready") {
        if (activity && !alreadyObserved) {
          await activity.emit("Using the already-ready FT3 inference server.");
        }
        return statusForOwner(instanceId, settings, existing);
      }
      if (existing.phase === "failed") {
        const probeResult = await probe(settings);
        if (probeResult.ready) {
          await settleReady(existing, probeResult);
          return statusForOwner(instanceId, settings, existing);
        }
        await emit(existing, "Retrying readiness checks for the existing FT3 process.");
        void watchReadiness(existing, settings);
      } else if (activity && !alreadyObserved) {
        await activity.emit("Joined the existing FT3 inference server startup.");
      }
      return statusForOwner(instanceId, settings, existing);
    }

    const flight = startFlights.get(key);
    if (flight) {
      if (startFlightSignatures.get(key) !== launchSignature(settings)) {
        releaseActiveOwnerForInstance(instanceId);
        return asStatus(instanceId, settings, owners.get(key), {
          phase: "failed",
          ownerKind: owners.get(key)?.alive ? "ft3" : "none",
          ready: false,
          progress: null,
          error:
            "A different Pi model/server profile is already starting at this endpoint. Wait for it to finish, then Stop and Start the selected model.",
          modelIds: owners.get(key)?.modelIds ?? [],
        });
      }
      if (activity) {
        const pendingOwner = owners.get(key);
        if (pendingOwner) {
          const alreadyObserved = pendingOwner.activities.has(activity.key);
          addActivity(pendingOwner, activity);
          if (!alreadyObserved) {
            await activity.emit(
              pendingOwner.phase === "ready"
                ? `Using the already-ready FT3 inference server (${pendingOwner.modelIds.join(", ")}).`
                : `Joined the existing FT3 inference server startup: ${pendingOwner.progress ?? "waiting for readiness checks"}.`,
            );
          }
        } else {
          const listeners = pendingActivities.get(key) ?? new Map<string, PiInferenceActivity>();
          const alreadyObserved = listeners.has(activity.key);
          listeners.set(activity.key, activity);
          pendingActivities.set(key, listeners);
          if (!alreadyObserved) {
            await activity.emit(
              `Joined the existing inference server start request (${activity.source === "manual" ? "manual" : "first message auto-start"}).`,
            );
          }
        }
      }
      const status = await flight;
      const joinedOwner = owners.get(key);
      const expectedModelId = piModelIdFromSlug(settings.model);
      const matchingReady =
        status.ready &&
        (!expectedModelId || status.modelIds.includes(expectedModelId)) &&
        (!joinedOwner?.alive || ownerMatchesSettings(joinedOwner, settings));
      if (joinedOwner?.alive && ownerMatchesSettings(joinedOwner, settings)) {
        rememberOwnerForInstance(instanceId, joinedOwner);
      }
      if (status.ready && !matchingReady) {
        return asStatus(instanceId, settings, joinedOwner, {
          phase: "failed",
          ownerKind: joinedOwner?.alive ? "ft3" : status.owner,
          ready: false,
          progress: null,
          error:
            "The joined Pi server start completed for a different model/profile; Stop and Start the selected model.",
          modelIds: status.modelIds,
        });
      }
      return status;
    }

    if (activity) {
      const listeners = pendingActivities.get(key) ?? new Map<string, PiInferenceActivity>();
      listeners.set(activity.key, activity);
      pendingActivities.set(key, listeners);
    }
    releaseActiveOwnerForInstance(instanceId);
    lastFailures.delete(key);
    launching.set(key, {
      progress: "Checking whether the configured local endpoint is already ready.",
    });
    startFlightSignatures.set(key, launchSignature(settings));
    const startFlight = (async () => {
      const activities = () => [...(pendingActivities.get(key)?.values() ?? [])];
      for (const listener of activities()) {
        await listener.emit(
          `Inference server start requested (${listener.source === "manual" ? "manual" : "first message auto-start"}).`,
        );
      }
      const external = await probe(settings);
      if (external.ready) {
        for (const listener of activities()) {
          await listener.emit(
            `Using external inference server; FT3 will not stop it (${external.modelIds.join(", ")}).`,
          );
        }
        return asStatus(instanceId, settings, undefined, {
          phase: "ready",
          ownerKind: "external",
          ready: true,
          progress: "External endpoint and model catalog are ready.",
          error: null,
          modelIds: external.modelIds,
          orphanedManagedEndpoint: orphanedEndpoint(instanceId, key),
        });
      }
      if (external.modelIds.length > 0) {
        const reason = external.reason;
        lastFailures.set(key, reason);
        return asStatus(instanceId, settings, undefined, {
          phase: "failed",
          ownerKind: "external",
          ready: false,
          progress: null,
          error: reason,
          modelIds: external.modelIds,
        });
      }
      const missing = await validateFiles(settings);
      if (missing) {
        lastFailures.set(key, missing);
        for (const listener of activities())
          await listener.emit(`Inference server could not start: ${missing}`);
        return asStatus(instanceId, settings, undefined, {
          phase: "failed",
          ownerKind: "none",
          ready: false,
          progress: null,
          error: missing,
          modelIds: [],
        });
      }
      const launchingState = launching.get(key);
      if (launchingState) launchingState.progress = "Creating the configured llama-server process.";
      let owner: ServerOwner;
      try {
        owner = await createOwner(instanceId, settings, activities());
        // A chat can join while file validation is pending. Attach its activity
        // even if it arrived after createOwner received its initial snapshot.
        for (const listener of activities()) {
          const joinedAfterProcessCreation = !owner.activities.has(listener.key);
          addActivity(owner, listener);
          if (joinedAfterProcessCreation) {
            await listener.emit(
              "FT3 created one llama-server process; checking /health and /v1/models.",
            );
          }
        }
      } catch (cause) {
        const knownReason = cause instanceof Error ? cause.message : "";
        const reason =
          /^(The inference endpoint must use HTTP on a loopback address\.|Configure both the llama-server executable and GGUF model file in Pi settings\.|Configure the direct llama-server executable; PowerShell launchers are not executed by FT3\.|The configured llama-server executable was not found as a file\.|The configured GGUF model file was not found as a file\.|Configure the GGUF model file in Pi settings\.)$/.test(
            knownReason,
          )
            ? knownReason
            : "FT3 could not create the configured llama-server process.";
        lastFailures.set(key, reason);
        for (const listener of activities())
          await listener.emit(`Inference server could not start: ${reason}`);
        return asStatus(instanceId, settings, undefined, {
          phase: "failed",
          ownerKind: "none",
          ready: false,
          progress: null,
          error: reason,
          modelIds: [],
        });
      }
      return statusForOwner(instanceId, settings, owner);
    })();
    startFlights.set(key, startFlight);
    try {
      return await startFlight;
    } finally {
      if (startFlights.get(key) === startFlight) startFlights.delete(key);
      startFlightSignatures.delete(key);
      launching.delete(key);
      pendingActivities.delete(key);
    }
  };

  const getStatus = async (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
  ): Promise<PiInferenceServerStatus> => {
    const url = parsePiLocalEndpoint(settings.baseUrl);
    if (!url) {
      releaseActiveOwnerForInstance(instanceId);
      return asStatus(instanceId, settings, undefined, {
        phase: "stopped",
        ownerKind: "none",
        ready: false,
        progress: null,
        error: "The endpoint must use HTTP on a loopback address.",
        modelIds: [],
        orphanedManagedEndpoint: orphanedEndpoint(instanceId),
      });
    }
    const key = endpointKey(url);
    const owner = owners.get(key);
    if (owner?.alive) {
      if (!ownerMatchesSettings(owner, settings)) {
        releaseActiveOwnerForInstance(instanceId);
        return statusForOwner(instanceId, settings, owner);
      }
      rememberOwnerForInstance(instanceId, owner);
      if (owner.stopping) return statusForOwner(instanceId, settings, owner);
      const expectedModelId = piModelIdFromSlug(settings.model);
      if (
        expectedModelId &&
        owner.modelIds.length > 0 &&
        !owner.modelIds.includes(expectedModelId)
      ) {
        return statusForOwner(instanceId, settings, owner);
      }
      const result = await probe(settings);
      if (result.ready) {
        if (!owner.stopping) await settleReady(owner, result);
      } else if (owner.phase === "ready") {
        owner.phase = "running";
        owner.progress = result.reason;
        owner.error = null;
        owner.modelIds = [];
      }
      return statusForOwner(instanceId, settings, owner);
    }
    const inFlight = startFlights.has(key);
    if (inFlight) {
      if (startFlightSignatures.get(key) !== launchSignature(settings)) {
        releaseActiveOwnerForInstance(instanceId);
        return asStatus(instanceId, settings, undefined, {
          phase: "failed",
          ownerKind: "none",
          ready: false,
          progress: null,
          error: "A different Pi model/server profile is starting at this endpoint.",
          modelIds: [],
        });
      }
      const state = launching.get(key);
      return asStatus(instanceId, settings, undefined, {
        phase: "starting",
        ownerKind: "none",
        ready: false,
        progress: state?.progress ?? "Starting the configured inference server.",
        error: null,
        modelIds: [],
        orphanedManagedEndpoint: orphanedEndpoint(instanceId, key),
      });
    }
    releaseActiveOwnerForInstance(instanceId);
    const external = await probe(settings);
    if (external.ready) lastFailures.delete(key);
    return asStatus(instanceId, settings, undefined, {
      phase: external.ready ? "ready" : lastFailures.has(key) ? "failed" : "stopped",
      ownerKind: external.ready ? "external" : "none",
      ready: external.ready,
      progress: external.ready ? "External endpoint and model catalog are ready." : null,
      error: external.ready
        ? null
        : (lastFailures.get(key) ?? configuredPathIssue(settings) ?? external.reason ?? null),
      modelIds: external.modelIds,
      orphanedManagedEndpoint: orphanedEndpoint(instanceId, key),
    });
  };

  const ensureReady = async (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
    activity?: PiInferenceActivity,
  ): Promise<PiInferenceServerStatus> => {
    const status = await start(instanceId, settings, activity);
    if (status.ready) return status;
    const url = parsePiLocalEndpoint(settings.baseUrl);
    const owner = url ? owners.get(endpointKey(url)) : undefined;
    if (!owner?.alive || owner.stopping) {
      throw new Error(status.error ?? "Inference server is not ready or is stopping.");
    }
    await owner.readyPromise;
    const ready = statusForOwner(instanceId, settings, owner);
    if (!ready.ready) throw new Error(ready.error ?? "Inference server is not ready.");
    return ready;
  };

  /** Wait for a start already requested by the user without starting a server here. */
  const waitForExistingReady = async (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
    activity?: PiInferenceActivity,
  ): Promise<PiInferenceServerStatus | undefined> => {
    const url = parsePiLocalEndpoint(settings.baseUrl);
    if (!url) {
      releaseActiveOwnerForInstance(instanceId);
      return undefined;
    }
    const key = endpointKey(url);
    const flight = startFlights.get(key);
    if (flight) {
      if (startFlightSignatures.get(key) !== launchSignature(settings)) {
        releaseActiveOwnerForInstance(instanceId);
        throw new Error(
          "A different Pi model/server profile is starting at this endpoint; the selected model cannot wait on it.",
        );
      }
      if (activity) {
        const listeners = pendingActivities.get(key) ?? new Map<string, PiInferenceActivity>();
        const alreadyObserved = listeners.has(activity.key);
        listeners.set(activity.key, activity);
        pendingActivities.set(key, listeners);
        if (!alreadyObserved) {
          await activity.emit("Joined the existing inference server start request.");
        }
      }
      const startingStatus = await flight;
      if (startingStatus.ready) {
        const startedOwner = owners.get(key);
        const expectedModelId = piModelIdFromSlug(settings.model);
        const matches =
          (!expectedModelId || startingStatus.modelIds.includes(expectedModelId)) &&
          (!startedOwner?.alive || ownerMatchesSettings(startedOwner, settings));
        if (!matches) {
          throw new Error(
            "The in-flight Pi server started a different model/profile; the selected model was not sent.",
          );
        }
        if (startedOwner?.alive) rememberOwnerForInstance(instanceId, startedOwner);
        return startingStatus;
      }
      if (startingStatus.phase === "failed") {
        throw new Error(startingStatus.error ?? "The inference server failed to start.");
      }
    }

    const owner = owners.get(key);
    if (!owner?.alive) {
      releaseActiveOwnerForInstance(instanceId);
      const external = await probe(settings);
      if (external.ready) {
        lastFailures.delete(key);
        return asStatus(instanceId, settings, undefined, {
          phase: "ready",
          ownerKind: "external",
          ready: true,
          progress: "External endpoint and model catalog are ready.",
          error: null,
          modelIds: external.modelIds,
        });
      }
      const previousFailure = lastFailures.get(key);
      if (previousFailure) throw new Error(previousFailure);
      return undefined;
    }
    if (!ownerMatchesSettings(owner, settings)) {
      releaseActiveOwnerForInstance(instanceId);
      throw new Error(
        "The FT3-owned Pi server is running a different model/profile; the selected model was not sent.",
      );
    }
    rememberOwnerForInstance(instanceId, owner);
    if (owner.stopping) {
      throw new Error("The FT3-owned inference server is stopping.");
    }
    if (owner.phase === "failed" || owner.phase === "stopped") {
      throw new Error(owner.error ?? "The FT3-owned inference server is not ready.");
    }
    const alreadyObserved = activity ? owner.activities.has(activity.key) : false;
    addActivity(owner, activity);
    if (activity && !alreadyObserved) {
      await activity.emit(
        owner.phase === "ready"
          ? `Using the already-ready FT3 inference server (${owner.modelIds.join(", ")}).`
          : "Waiting for the already-started FT3 inference server to become ready.",
      );
    }
    if (owner.phase !== "ready") await owner.readyPromise;
    if (owner.stopping || !owner.alive || owner.phase !== "ready") {
      throw new Error(
        owner.error ?? "The FT3-owned inference server stopped before becoming ready.",
      );
    }
    const ready = statusForOwner(instanceId, settings, owner);
    if (!ready.ready) throw new Error(ready.error ?? "The selected Pi model is not ready.");
    return ready;
  };

  const releaseActivity = (
    instanceId: ProviderInstanceId,
    threadId: ThreadId,
    baseUrl: string,
  ): void => {
    const url = parsePiLocalEndpoint(baseUrl);
    const preferredKey = url ? endpointKey(url) : undefined;
    const activityKey = `${instanceId}:${threadId}`;
    const removeFrom = (activities: Map<string, PiInferenceActivity>) => {
      const activity = activities.get(activityKey);
      if (activity?.instanceId === instanceId && activity.threadId === threadId) {
        activities.delete(activityKey);
      }
    };
    if (preferredKey) {
      const pending = pendingActivities.get(preferredKey);
      if (pending) removeFrom(pending);
      if (pending?.size === 0) pendingActivities.delete(preferredKey);
      const owner = owners.get(preferredKey);
      if (owner) removeFrom(owner.activities);
    }
    for (const [key, pending] of pendingActivities) {
      if (key === preferredKey) continue;
      removeFrom(pending);
      if (pending.size === 0) pendingActivities.delete(key);
    }
    for (const [key, owner] of owners) {
      if (key !== preferredKey) removeFrom(owner.activities);
    }
  };

  const releaseInstance = (instanceId: ProviderInstanceId): void => {
    releaseActiveOwnerForInstance(instanceId);
    for (const [key, activities] of pendingActivities) {
      for (const [activityKey, activity] of activities) {
        if (activity.instanceId === instanceId) activities.delete(activityKey);
      }
      if (activities.size === 0) pendingActivities.delete(key);
    }
    for (const owner of owners.values()) {
      for (const [activityKey, activity] of owner.activities) {
        if (activity.instanceId === instanceId) owner.activities.delete(activityKey);
      }
    }
  };

  const stop = async (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
    activity?: PiInferenceActivity,
  ): Promise<PiInferenceServerStatus> => {
    const url = parsePiLocalEndpoint(settings.baseUrl);
    const currentKey = url ? endpointKey(url) : undefined;
    observeInstanceEndpoint(instanceId, currentKey);
    const currentOwner = currentKey ? owners.get(currentKey) : undefined;
    const owner =
      currentOwner?.alive === true ? currentOwner : findOrphanedOwner(instanceId, currentKey);
    // No process lookup by executable name or port is allowed here. Only the
    // ChildProcess object captured when FT3 spawned the server can be stopped.
    if (!owner?.alive) return getStatus(instanceId, settings);
    if (hasOtherActiveInstances(instanceId, owner))
      return statusForOwner(instanceId, settings, owner);
    addActivity(owner, activity);
    owner.stopping = true;
    owner.controller.abort();
    owner.progress = "Stopping the FT3-owned inference process.";
    await emit(owner, "Stopping the FT3-owned inference server.");
    owner.child.kill("SIGTERM");
    await Promise.race([owner.closed, deps.sleep(4_000)]);
    if (owner.alive) {
      owner.child.kill("SIGKILL");
      await Promise.race([owner.closed, deps.sleep(1_000)]);
    }
    if (owner.alive) {
      owner.stopping = false;
      owner.phase = "failed";
      owner.error = "FT3 could not confirm that its inference process exited.";
      owner.progress = null;
      owner.notifiedTerminal = true;
      return statusForOwner(instanceId, settings, owner);
    }
    owners.delete(owner.key);
    forgetOwnerAssociations(owner);
    lastFailures.delete(owner.key);
    owner.phase = "stopped";
    owner.progress = null;
    owner.error = null;
    owner.modelIds = [];
    await emit(owner, "The FT3-owned inference server stopped.");
    owner.activities.clear();
    return asStatus(instanceId, settings, undefined, {
      phase: "stopped",
      ownerKind: "none",
      ready: false,
      progress: null,
      error: null,
      modelIds: [],
      orphanedManagedEndpoint: orphanedEndpoint(instanceId, currentKey),
    });
  };

  const acquireRequestSlot = (
    baseUrl: string,
    onQueued?: (() => void) | undefined,
    signal?: AbortSignal | undefined,
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
    onQueued?.();
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Inference request was interrupted while queued."));
        return;
      }
      const waiter: (typeof slot.waiters)[number] = {
        resolve,
        ...(signal ? { signal } : {}),
      };
      const abort = () => {
        slot!.waiters = slot!.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error("Inference request was interrupted while queued."));
      };
      if (signal) {
        waiter.abort = abort;
        signal.addEventListener("abort", abort, { once: true });
      }
      slot!.waiters.push(waiter);
    });
  };

  const makeRelease = (
    slot: {
      active: boolean;
      waiters: Array<{
        resolve: (release: () => void) => void;
        signal?: AbortSignal;
        abort?: () => void;
      }>;
    },
    key: string,
  ): (() => void) => {
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

  const shutdown = (): void => {
    for (const owner of owners.values()) {
      if (owner.alive) owner.child.kill("SIGTERM");
    }
  };

  return {
    start,
    getStatus,
    ensureReady,
    waitForExistingReady,
    releaseActivity,
    releaseInstance,
    stop,
    acquireRequestSlot,
    shutdown,
  };
}

export const piInferenceServerManager = makePiInferenceServerManager();

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
        await NodeFSP.access(filePath);
        return (await NodeFSP.stat(filePath)).isFile();
      } catch {
        return false;
      }
    });
  const environment = options.environment ?? process.env;
  const selectedRoot = options.rootPath?.trim();
  const configuredRoot = environment.BONSAI_DEMO_HOME?.trim();
  const roots = selectedRoot ? [selectedRoot] : configuredRoot ? [configuredRoot] : [];
  for (const normalizedRoot of roots) {
    const join = NodePath.win32.isAbsolute(normalizedRoot) ? NodePath.win32.join : NodePath.join;
    const executablePath = join(normalizedRoot, "bin", "cuda", "llama-server.exe");
    const modelPath = join(
      normalizedRoot,
      "models",
      "bonsai2-gguf",
      "27B",
      "Ternary-Bonsai-2-27B-PQ2_0.gguf",
    );
    if ((await isFile(executablePath)) && (await isFile(modelPath))) {
      return {
        executablePath,
        modelPath,
        baseUrl: "http://127.0.0.1:8080/v1",
        model: PI_BONSAI_MODEL_ID,
      };
    }
  }
  return null;
}

export function makePiInferenceActivity(input: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId | undefined;
  readonly source: "manual" | "automatic";
  readonly emit: ((message: string) => Promise<void>) | undefined;
}): PiInferenceActivity | undefined {
  if (!input.threadId || !input.emit) return undefined;
  return {
    key: `${input.instanceId}:${input.threadId}`,
    instanceId: input.instanceId,
    threadId: input.threadId,
    source: input.source,
    emit: input.emit,
  };
}

process.once("exit", () => piInferenceServerManager.shutdown());
