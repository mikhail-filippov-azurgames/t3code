import type { PiInferenceServerStatus } from "@t3tools/ft3-pi/rpc-contracts";

export type PiInferenceTone = "off" | "starting" | "ready" | "failed";

export type PiInferenceAction = "start" | "stop";

export function piInferenceEndpointLabel(endpoint: string): string {
  try {
    const origin = new URL(endpoint).origin;
    return origin === "null" ? "local endpoint" : origin;
  } catch {
    return "local endpoint";
  }
}

export function piInferenceTone(status: PiInferenceServerStatus | null): PiInferenceTone {
  if (status === null) return "off";
  if (status.ready) return "ready";
  if (status.phase === "starting") return "starting";
  if (status.phase === "failed") return "failed";
  return "off";
}

/** Stop wins over start: an owned process is always stoppable. */
export function piInferenceAction(
  status: PiInferenceServerStatus | null,
): PiInferenceAction | null {
  if (status?.owned) return "stop";
  if (status?.canStart) return "start";
  return null;
}

export function piInferenceActionLabel(
  status: PiInferenceServerStatus | null,
  pending: PiInferenceAction | null,
): string {
  if (pending === "start") return "Starting…";
  if (pending === "stop") return "Stopping…";
  const action = piInferenceAction(status);
  if (action === "stop") return "Stop";
  if (action === "start") return status?.phase === "failed" ? "Retry" : "Start";
  return "Start";
}

export function piInferenceActionDisabled(
  status: PiInferenceServerStatus | null,
  pending: PiInferenceAction | null,
): boolean {
  return pending !== null || status?.phase === "starting" || piInferenceAction(status) === null;
}

export function piInferenceStatusLabel(
  status: PiInferenceServerStatus | null,
  requestError: string | null = null,
): string {
  if (status === null) return requestError ?? "Pi inference server status is loading.";
  if (status.error) return status.error;
  if (status.ready) {
    const endpoint = piInferenceEndpointLabel(status.endpoint);
    const models = status.modelIds.length > 0 ? ` Model: ${status.modelIds.join(", ")}.` : "";
    return status.owned
      ? `Inference server ready at ${endpoint}.${models}`
      : `External inference server ready at ${endpoint}.${models}`;
  }
  if (status.phase === "starting") return "Starting the local inference server.";
  if (status.phase === "failed") return "Inference server failed.";
  if (requestError) return requestError;
  return status.canStart
    ? "Inference server is off."
    : "No managed llama-server profile for the selected model.";
}
