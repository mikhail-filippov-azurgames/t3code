import type { EnvironmentId, PiInferenceServerStatus, ServerProvider } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";

type Observation = {
  readonly key: string;
  readonly status?: PiInferenceServerStatus;
  readonly error?: string;
};

const isPiModel = (model: string | undefined): boolean => model?.startsWith("ft3-local/") === true;

export function selectedPiStatusKey(
  environmentId: EnvironmentId,
  provider: ServerProvider | null,
  selectedModel: string | undefined,
): string | null {
  return provider?.driver === "pi" &&
    provider.installed &&
    provider.status !== "error" &&
    isPiModel(selectedModel)
    ? `${environmentId}\u0000${provider.instanceId}\u0000${selectedModel}`
    : null;
}

export function resolveSelectedPiProviderStatus(
  provider: ServerProvider | null,
  selectedModel: string | undefined,
  observation: Observation | null,
  key: string | null,
): ServerProvider | null {
  // A provider switch can leave the thread's previous model selected briefly.
  // Never interpret that model as a Pi inference-server profile.
  if (provider?.driver === "pi" && selectedModel && !isPiModel(selectedModel)) return null;
  if (provider?.driver === "pi" && provider.message === "Checking bundled Pi runtime...") {
    return null;
  }
  if (
    !provider ||
    key === null ||
    !selectedModel ||
    !provider.installed ||
    provider.status === "error"
  ) {
    return provider;
  }
  if (observation?.key !== key) return null;
  if (observation.error) return { ...provider, status: "warning", message: observation.error };
  const status = observation.status;
  if (!status) return null;
  if (status.ready) return { ...provider, status: "ready", message: undefined };
  return {
    ...provider,
    status: "warning",
    message:
      status.error ??
      status.progress ??
      `Pi model ${selectedModel} is not ready at ${status.endpoint}.`,
  };
}

export function useSelectedPiProviderStatus(
  environmentId: EnvironmentId,
  provider: ServerProvider | null,
  selectedModel: string | undefined,
): ServerProvider | null {
  const getStatus = useAtomCommand(serverEnvironment.piInferenceServerStatus, {
    reportFailure: false,
  });
  const instanceId = provider?.instanceId;
  const installed = provider?.installed;
  const key = selectedPiStatusKey(environmentId, provider, selectedModel);
  const [observation, setObservation] = useState<Observation | null>(null);

  useEffect(() => {
    if (key === null || !instanceId || !selectedModel || !installed) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await getStatus({
          environmentId,
          input: { instanceId, model: selectedModel },
        });
        if (!active) return;
        setObservation(
          result._tag === "Success"
            ? { key, status: result.value }
            : { key, error: formatEnvironmentQueryError(result.cause) },
        );
      } catch (cause) {
        if (active) {
          setObservation({
            key,
            error:
              cause instanceof Error ? cause.message : "Could not check the selected Pi model.",
          });
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [environmentId, getStatus, key, installed, instanceId, selectedModel]);

  return resolveSelectedPiProviderStatus(provider, selectedModel, observation, key);
}
