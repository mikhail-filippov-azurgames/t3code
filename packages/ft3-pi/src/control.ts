import {
  applyPiBonsaiPresetToConfig,
  detectPiBonsaiPreset,
  loadPiInferenceConfig,
  resolvePiInferenceProfile,
  savePiInferenceConfig,
  type PiInferenceConfig,
  type PiInferenceServerManager,
  type PiInferenceServerStatus as ManagerStatus,
} from "./inferenceServer.ts";
import type { PiBonsaiPreset, PiInferenceServerStatus } from "./rpc-contracts.ts";

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
