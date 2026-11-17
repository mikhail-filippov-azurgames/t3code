import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";

export type ZavodFailureKind = "unavailable" | "model_access_denied" | "transient" | "rate_limited";

/** Instance ids created by "Connect Zavod"; other ids are never treated as Zavod. */
export const ZAVOD_INSTANCE_IDS: ReadonlySet<string> = new Set([
  "claudeZavod",
  "codexZavod",
  "zavod-claude",
  "zavod-codex",
]);

export function isZavodInstanceId(instanceId: string | null | undefined): boolean {
  return instanceId != null && ZAVOD_INSTANCE_IDS.has(instanceId);
}

const UNAVAILABLE_MARKERS = ["ECONNREFUSED", "ENOTFOUND", "fetch failed", "Connection error"];

export function classifyZavodFailure(input: {
  readonly instanceId: string | null | undefined;
  readonly errorClass: OrchestrationV2ProviderFailureClass | null | undefined;
  readonly errorCode: string | null | undefined;
  readonly message: string | null | undefined;
}): ZavodFailureKind | null {
  if (!isZavodInstanceId(input.instanceId)) return null;
  const message = input.message ?? "";
  const code = input.errorCode ?? "";
  if (message.includes("team_model_access_denied") || code === "team_model_access_denied") {
    return "model_access_denied";
  }
  // The 503 body carries `code: internal_server_error`; only the message names the cause.
  if (message.includes("auth_unavailable")) return "transient";
  if (
    message.includes("429 Too Many Requests") ||
    code === "api_error_429" ||
    input.errorClass === "usage_limit"
  ) {
    return "rate_limited";
  }
  if (
    input.errorClass === "transport_error" ||
    UNAVAILABLE_MARKERS.some((marker) => message.includes(marker))
  ) {
    return "unavailable";
  }
  return null;
}
