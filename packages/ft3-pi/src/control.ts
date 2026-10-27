import {
  applyPiBonsaiPresetToConfig,
  buildPiInferenceServerArgs,
  detectPiBonsaiPreset,
  loadPiInferenceConfig,
  resolvePiInferenceProfile,
  savePiInferenceConfig,
  type PiInferenceConfig,
  type PiInferenceProfile,
  type PiInferenceServerManager,
  type PiInferenceServerStatus as ManagerStatus,
} from "./inferenceServer.ts";
import { normalizePiModelSlug, piModelIdFromSlug } from "./agentDir.ts";
import type {
  PiBonsaiPreset,
  PiInferenceProfileSettings,
  PiInferenceServerStatus,
} from "./rpc-contracts.ts";

export interface PiInferenceControlDependencies {
  readonly manager: Pick<
    PiInferenceServerManager,
    "registerInstance" | "registeredConfig" | "registeredConfigPath" | "status" | "start" | "stop"
  >;
  readonly detectPreset?: typeof detectPiBonsaiPreset;
  readonly readConfig?: typeof loadPiInferenceConfig;
  readonly writeConfig?: typeof savePiInferenceConfig;
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const PROFILE_DEFAULTS = {
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
} as const;

/** Profile view for the parameters dialog; absent profiles start from launch defaults. */
function profileSettings(
  profile: PiInferenceProfile | undefined,
  model: string,
  fallbackBaseUrl: string,
): PiInferenceProfileSettings {
  return {
    model: normalizePiModelSlug(model) ?? model,
    baseUrl: profile?.baseUrl ?? fallbackBaseUrl,
    executablePath: profile?.executablePath ?? "",
    modelPath: profile?.modelPath ?? "",
    gpuLayers: profile?.gpuLayers ?? PROFILE_DEFAULTS.gpuLayers,
    contextSize: profile?.contextSize ?? PROFILE_DEFAULTS.contextSize,
    parallel: profile?.parallel ?? PROFILE_DEFAULTS.parallel,
    temperature: profile?.temperature ?? PROFILE_DEFAULTS.temperature,
    topP: profile?.topP ?? PROFILE_DEFAULTS.topP,
    topK: profile?.topK ?? PROFILE_DEFAULTS.topK,
    minP: profile?.minP ?? PROFILE_DEFAULTS.minP,
    flashAttention: profile?.flashAttention ?? PROFILE_DEFAULTS.flashAttention,
    cacheTypeK:
      profile?.cacheTypeK === "q8_0" ||
      profile?.cacheTypeK === "f16" ||
      profile?.cacheTypeK === "bf16" ||
      profile?.cacheTypeK === "f32"
        ? profile.cacheTypeK
        : PROFILE_DEFAULTS.cacheTypeK,
    cacheTypeV:
      profile?.cacheTypeV === "q8_0" ||
      profile?.cacheTypeV === "f16" ||
      profile?.cacheTypeV === "bf16" ||
      profile?.cacheTypeV === "f32"
        ? profile.cacheTypeV
        : PROFILE_DEFAULTS.cacheTypeV,
    jinja: profile?.jinja ?? PROFILE_DEFAULTS.jinja,
    reasoning: profile?.reasoning ?? PROFILE_DEFAULTS.reasoning,
    reasoningEffort:
      profile?.reasoningEffort === "low" || profile?.reasoningEffort === "high"
        ? profile.reasoningEffort
        : PROFILE_DEFAULTS.reasoningEffort,
  };
}

function profileFromSettings(settings: PiInferenceProfileSettings): PiInferenceProfile {
  const profile: PiInferenceProfile = {
    model: normalizePiModelSlug(settings.model) ?? settings.model,
    baseUrl: settings.baseUrl,
    executablePath: settings.executablePath,
    modelPath: settings.modelPath,
    gpuLayers: settings.gpuLayers,
    contextSize: settings.contextSize,
    parallel: settings.parallel,
    temperature: settings.temperature,
    topP: settings.topP,
    topK: settings.topK,
    minP: settings.minP,
    flashAttention: settings.flashAttention,
    cacheTypeK: settings.cacheTypeK,
    cacheTypeV: settings.cacheTypeV,
    jinja: settings.jinja,
    reasoning: settings.reasoning,
    reasoningEffort: settings.reasoningEffort,
  };
  if (profile.executablePath.trim().length === 0 || profile.modelPath.trim().length === 0) {
    throw new Error("The llama-server executable and GGUF model file are required.");
  }
  buildPiInferenceServerArgs(profile);
  return profile;
}

/** Control path shared by the RPC handlers and tests; it never spawns a process itself. */
export function makePiInferenceControl(dependencies: PiInferenceControlDependencies) {
  const detectPreset = dependencies.detectPreset ?? detectPiBonsaiPreset;
  const readConfig = dependencies.readConfig ?? loadPiInferenceConfig;
  const writeConfig = dependencies.writeConfig ?? savePiInferenceConfig;

  const view = (status: ManagerStatus, canStart: boolean): PiInferenceServerStatus => ({
    instanceId: status.instanceId,
    phase: status.phase,
    ready: status.ready,
    endpoint: status.endpoint,
    model: status.model ?? null,
    modelIds: [...status.modelIds],
    owned: status.owned,
    // An external server already serving the model must not offer Start.
    canStart: canStart && !(status.ready && !status.owned),
    error: status.error,
  });

  const failed = (
    instanceId: string,
    model: string | undefined,
    error: string,
    canStart: boolean,
  ): PiInferenceServerStatus => ({
    instanceId,
    phase: "failed",
    ready: false,
    endpoint: "",
    model: model ?? null,
    modelIds: [],
    owned: false,
    canStart,
    error,
  });

  const prepare = (
    instanceId: string,
    model: string | undefined,
  ): { readonly config: PiInferenceConfig; readonly canStart: boolean } => {
    const config = dependencies.manager.registeredConfig(instanceId);
    if (config === undefined) {
      throw new Error(
        `Pi inference config for ${instanceId} is not registered; recreate the provider instance.`,
      );
    }
    return { config, canStart: resolvePiInferenceProfile(config, model) !== undefined };
  };

  return {
    status: async (
      instanceId: string,
      model: string | undefined,
    ): Promise<PiInferenceServerStatus> => {
      let prepared: { readonly config: PiInferenceConfig; readonly canStart: boolean };
      try {
        prepared = prepare(instanceId, model);
      } catch (cause) {
        return failed(instanceId, model, failureMessage(cause), false);
      }
      try {
        return view(await dependencies.manager.status(instanceId, model), prepared.canStart);
      } catch (cause) {
        return failed(instanceId, model, failureMessage(cause), prepared.canStart);
      }
    },

    start: async (
      instanceId: string,
      model: string | undefined,
    ): Promise<PiInferenceServerStatus> => {
      let prepared: { readonly config: PiInferenceConfig; readonly canStart: boolean };
      try {
        prepared = prepare(instanceId, model);
      } catch (cause) {
        return failed(instanceId, model, failureMessage(cause), false);
      }
      try {
        return view(await dependencies.manager.start(instanceId, model), prepared.canStart);
      } catch (cause) {
        return failed(instanceId, model, failureMessage(cause), prepared.canStart);
      }
    },

    stop: async (
      instanceId: string,
      model: string | undefined,
    ): Promise<PiInferenceServerStatus> => {
      let prepared: { readonly config: PiInferenceConfig; readonly canStart: boolean };
      try {
        prepared = prepare(instanceId, model);
      } catch (cause) {
        return failed(instanceId, model, failureMessage(cause), false);
      }
      try {
        return view(await dependencies.manager.stop(instanceId), prepared.canStart);
      } catch (cause) {
        return failed(instanceId, model, failureMessage(cause), prepared.canStart);
      }
    },

    detectPreset: (rootPath?: string): Promise<PiBonsaiPreset | null> =>
      detectPreset(rootPath === undefined ? {} : { rootPath }),

    /** Current launch settings for one model, with launch defaults for unset fields. */
    profile: (instanceId: string, model: string): PiInferenceProfileSettings => {
      const { config } = prepare(instanceId, model);
      return profileSettings(resolvePiInferenceProfile(config, model), model, config.baseUrl);
    },

    /** Persist one model's launch settings; running servers apply them on the next start. */
    saveProfile: async (
      instanceId: string,
      settings: PiInferenceProfileSettings,
    ): Promise<PiInferenceProfileSettings> => {
      const profile = profileFromSettings(settings);
      const configPath = dependencies.manager.registeredConfigPath(instanceId);
      if (configPath === undefined) {
        throw new Error(
          `Pi inference config path for ${instanceId} is not registered; recreate the provider instance.`,
        );
      }
      const current = await readConfig(configPath);
      const targetId = piModelIdFromSlug(profile.model) ?? profile.model;
      const matchesTarget = (candidate: PiInferenceProfile) =>
        (piModelIdFromSlug(candidate.model) ?? candidate.model) === targetId;
      const profiles = current.profiles.some(matchesTarget)
        ? current.profiles.map((candidate) => (matchesTarget(candidate) ? profile : candidate))
        : [...current.profiles, profile];
      const next: PiInferenceConfig = { ...current, profiles };
      await writeConfig(configPath, next);
      dependencies.manager.registerInstance(instanceId, next, configPath);
      return profileSettings(profile, profile.model, next.baseUrl);
    },

    /** Persist the preset into the instance's own profile file, then re-register it. */
    applyPreset: async (instanceId: string, rootPath?: string): Promise<PiBonsaiPreset | null> => {
      const preset = await detectPreset(rootPath === undefined ? {} : { rootPath });
      if (!preset) return null;
      const configPath = dependencies.manager.registeredConfigPath(instanceId);
      if (configPath === undefined) {
        throw new Error(
          `Pi inference config path for ${instanceId} is not registered; recreate the provider instance.`,
        );
      }
      const next = applyPiBonsaiPresetToConfig(await readConfig(configPath), preset);
      await writeConfig(configPath, next);
      dependencies.manager.registerInstance(instanceId, next, configPath);
      return preset;
    },
  };
}
