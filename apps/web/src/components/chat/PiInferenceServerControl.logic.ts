import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type {
  PiBonsaiPreset,
  PiInferenceServerStatus,
  PiSettings as PiSettingsType,
} from "@t3tools/contracts";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import { desktopLocalBackendId, isWslConnectionTarget } from "../../connection/desktopLocal";

export type PiInferenceServerTone = "off" | "starting" | "ready";

/** Return only settings changed in this editor since it was opened. */
export function diffPiSettings(
  base: PiSettingsType,
  draft: PiSettingsType,
): Partial<PiSettingsType> {
  const changed = Object.keys(draft).filter((key) => {
    const typedKey = key as keyof PiSettingsType;
    return JSON.stringify(base[typedKey]) !== JSON.stringify(draft[typedKey]);
  });
  return Object.fromEntries(
    changed.map((key) => [key, draft[key as keyof PiSettingsType]]),
  ) as Partial<PiSettingsType>;
}

const PI_BONSAI_27B_MODEL_IDS = new Set(["bonsai-2-27b", "ft3-local/bonsai-2-27b"]);

export function resolvePiBonsaiFolderPickerTarget(
  isElectronClient: boolean,
  target: ConnectionTarget | null,
): string | null {
  if (!isElectronClient || target === null) return null;
  if (target._tag === "PrimaryConnectionTarget") return PRIMARY_LOCAL_ENVIRONMENT_ID;
  if (!isWslConnectionTarget(target)) return null;
  return desktopLocalBackendId(target);
}

export function isPiBonsai27BModel(model: string): boolean {
  return PI_BONSAI_27B_MODEL_IDS.has(model);
}

function modelIdsMatch(left: string, right: string): boolean {
  return (
    left === right ||
    (left === "ft3-local/bonsai-2-27b" && right === "bonsai-2-27b") ||
    (right === "ft3-local/bonsai-2-27b" && left === "bonsai-2-27b")
  );
}

export function piInferenceProfileForModel(
  settings: PiSettingsType,
  model: string,
): PiSettingsType["inferenceServerProfiles"][number] | undefined {
  return settings.inferenceServerProfiles.find((profile) => modelIdsMatch(profile.model, model));
}

export function hasUsablePiInferenceProfile(
  profile: PiSettingsType["inferenceServerProfiles"][number] | undefined,
): boolean {
  return Boolean(
    profile?.executablePath.trim() && profile.modelPath.trim() && profile.baseUrl.trim(),
  );
}

/** Add a verified 27B preset to the open draft without enabling or saving anything. */
export function applyPiBonsaiPresetToSettings(
  settings: PiSettingsType,
  selectedModel: string,
  preset: PiBonsaiPreset,
): PiSettingsType {
  if (!isPiBonsai27BModel(selectedModel) || preset.model !== "bonsai-2-27b") {
    throw new Error("The detected Bonsai preset does not match the selected Pi model.");
  }
  const profiles = settings.inferenceServerProfiles.filter(
    (profile) => !modelIdsMatch(profile.model, selectedModel),
  );
  return {
    ...settings,
    inferenceServerProfiles: [
      ...profiles,
      {
        model: selectedModel,
        executablePath: preset.executablePath,
        modelPath: preset.modelPath,
        baseUrl: preset.baseUrl,
      },
    ],
  };
}

export function piInferenceServerCanStop(status: PiInferenceServerStatus | null): boolean {
  if (status?.usedByOtherInstances === true) return false;
  return status?.canStop === true || Boolean(status?.orphanedManagedEndpoint);
}

export function piInferenceServerControlVisible(status: PiInferenceServerStatus | null): boolean {
  return status?.local !== false || Boolean(status.orphanedManagedEndpoint);
}

export function piInferenceServerPendingRestart(status: PiInferenceServerStatus | null): boolean {
  return status?.owner === "ft3" && status.pendingRestart;
}

export function piInferenceServerReadyRefreshKey(
  status: PiInferenceServerStatus | null,
  environmentId: string,
  instanceId: string,
): string | null {
  if (!status?.ready) return null;
  const modelKey = JSON.stringify([...status.modelIds].sort());
  return `${environmentId}:${instanceId}:${status.endpoint}:${modelKey}`;
}

function displayEndpointOrigin(endpoint: string): string {
  try {
    const origin = new URL(endpoint).origin;
    return origin === "null" ? "local endpoint" : origin;
  } catch {
    return "local endpoint";
  }
}

export function piInferenceServerTone(
  status: PiInferenceServerStatus | null,
): PiInferenceServerTone {
  if (status?.ready) return "ready";
  if (status?.owner === "ft3") return "starting";
  return "off";
}

export function piInferenceServerStatusLabel(
  status: PiInferenceServerStatus | null,
  requestError: string | null = null,
): string {
  if (!status) return requestError ?? "Pi inference server status is loading.";
  if (status.usedByOtherInstances && status.owner === "ft3") {
    return "FT3-managed inference server is shared with another Pi instance; Stop is disabled.";
  }
  if (status.ready) {
    const models = status.modelIds.length > 0 ? ` Model: ${status.modelIds.join(", ")}.` : "";
    const endpoint = displayEndpointOrigin(status.endpoint);
    return status.owner === "external"
      ? `External inference server ready at ${endpoint}.${models}`
      : `Inference server ready at ${endpoint}.${models}`;
  }
  if (status.error) return status.error;
  if (status.progress) return status.progress;
  if (status.phase === "starting") return "Checking the local endpoint before launch.";
  return requestError ?? "Inference server is off.";
}
