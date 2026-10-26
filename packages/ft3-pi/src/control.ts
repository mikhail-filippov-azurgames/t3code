import {
  resolvePiInferenceProfile,
  type PiInferenceConfig,
  type PiInferenceServerManager,
  type PiInferenceServerStatus as ManagerStatus,
} from "./inferenceServer.ts";
import type { PiInferenceServerStatus } from "./rpc-contracts.ts";

export interface PiInferenceControlDependencies {
  readonly manager: Pick<
    PiInferenceServerManager,
    "registerInstance" | "registeredConfig" | "status" | "start" | "stop"
  >;
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Control path shared by the RPC handlers and tests; it never spawns a process itself. */
export function makePiInferenceControl(dependencies: PiInferenceControlDependencies) {
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
  };
}
