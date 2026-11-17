import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";

export interface ZavodErrorFixture {
  readonly instanceId: string;
  readonly errorClass: OrchestrationV2ProviderFailureClass | null;
  readonly errorCode: string | null;
  readonly message: string;
}

/** Codex on codexZavod, gpt-6.1-sol, 503 from the gateway (recorded 2026-11-17). */
export const CODEX_ZAVOD_503_AUTH_UNAVAILABLE: ZavodErrorFixture = {
  instanceId: "codexZavod",
  errorClass: "provider_error",
  errorCode: null,
  message:
    'unexpected status 503 Service Unavailable: litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - {"error":{"message":"auth_unavailable: no auth available (providers=home, model=gpt-6.1-sol)","type":"server_error","code":"internal_server_error"}}\n\nLiteLLM: model group \'gpt-6.1-sol\' failed with the error above. No fallback was attempted., url: https://zavod-gateway.example/v1/responses',
};

/** Codex on codexZavod, 429 with no body (recorded 2026-11-17). */
export const CODEX_ZAVOD_429: ZavodErrorFixture = {
  instanceId: "codexZavod",
  errorClass: "provider_error",
  errorCode: null,
  message: "exceeded retry limit, last status: 429 Too Many Requests",
};

/** Claude on claudeZavod, claude-haiku-5-5, 403; only the body code is confirmed. */
export const CLAUDE_ZAVOD_403_MODEL_ACCESS: ZavodErrorFixture = {
  instanceId: "claudeZavod",
  errorClass: "permission_error",
  errorCode: "api_error_403",
  message: 'API Error: 403 {"error":{"code":"team_model_access_denied","message":"…"}}',
};

/** Gateway unreachable; synthetic network failure. */
export const CLAUDE_ZAVOD_UNREACHABLE: ZavodErrorFixture = {
  instanceId: "zavod-claude",
  errorClass: "transport_error",
  errorCode: null,
  message: "Connection error.",
};
