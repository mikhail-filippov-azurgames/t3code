import type { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/**
 * Client-side contract for the thread-menu "Switch provider" entry point,
 * rebuilt on V2's native provider handoff: the target provider/model is
 * persisted with `thread.update-metadata`, and the server hands the thread
 * off when the current provider session supports it. The UI still collects
 * the same three fields the old engine switch did (target provider, model,
 * and a reason), but the reason now only rides along for surfaces that can
 * use it (for example the Architect replace prompt); the native handoff
 * itself carries no reason.
 */

export interface SwitchProviderTarget {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
}

export interface SwitchProviderInput {
  readonly threadId: ThreadId;
  readonly target: SwitchProviderTarget;
  /** Always non-empty after resolution; kept for transport parity with the old engine switch. */
  readonly reason: string;
}

/** Field bound for the optional reason input. */
export const SWITCH_PROVIDER_REASON_MAX_LENGTH = 2_000;

/** Used when the user leaves the optional reason field blank. */
export const DEFAULT_SWITCH_PROVIDER_REASON = "Switched from the thread menu.";

/**
 * The UI reason field is optional. Blank input falls back to the default and
 * overlong input is truncated to the field bound instead of failing validation.
 */
export function resolveSwitchProviderReason(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return DEFAULT_SWITCH_PROVIDER_REASON;
  if (trimmed.length > SWITCH_PROVIDER_REASON_MAX_LENGTH) {
    return trimmed.slice(0, SWITCH_PROVIDER_REASON_MAX_LENGTH);
  }
  return trimmed;
}

export function buildSwitchProviderInput(input: {
  readonly threadId: ThreadId;
  readonly target: SwitchProviderTarget;
  readonly reason?: string | null;
}): SwitchProviderInput {
  return {
    threadId: input.threadId,
    target: {
      providerInstanceId: input.target.providerInstanceId,
      driverKind: input.target.driverKind,
      model: input.target.model,
    },
    reason: resolveSwitchProviderReason(input.reason),
  };
}

/**
 * The menu entry is visible where a handoff can happen: subagent threads
 * (delegated, `lineage.parentThreadId`) and started threads with provider
 * work behind them (`latestRun` / `latestUserMessageAt` / `runtime`). The
 * server stays authoritative — an unsupported handoff fails with a visible
 * toast. Optional fields so shells from older servers still decode.
 */
export function canSwitchThreadProvider(
  thread:
    | {
        readonly lineage?: { readonly parentThreadId: unknown } | null | undefined;
        readonly latestRun?: unknown;
        readonly latestUserMessageAt?: string | null | undefined;
        readonly runtime?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (thread == null) return false;
  if (thread.lineage?.parentThreadId != null) return true;
  return thread.latestRun != null || thread.latestUserMessageAt != null || thread.runtime != null;
}

export type SwitchProviderResult =
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly code?: string; readonly message: string };

/**
 * Delivers a switch request. The web hook persists the model selection through
 * `thread.update-metadata` by default; callers can inject another transport
 * for tests or alternate clients.
 */
export type SwitchProviderTransport = (input: SwitchProviderInput) => Promise<SwitchProviderResult>;

export class SwitchProviderEngineUnavailableError extends Error {
  constructor() {
    super(
      "Switching providers is not available yet: this environment's server does not accept provider switches from the UI.",
    );
    this.name = "SwitchProviderEngineUnavailableError";
  }
}

export const missingSwitchProviderTransport: SwitchProviderTransport = async () => {
  throw new SwitchProviderEngineUnavailableError();
};

export interface SwitchProviderFailure {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * Handoff failures must surface visibly: the toast always includes the
 * server's own reason text when one is present.
 */
export function resolveSwitchProviderFailureMessage(failure: SwitchProviderFailure): string {
  const detail =
    failure.message !== undefined && failure.message.trim().length > 0
      ? failure.message.trim()
      : null;
  switch (failure.code) {
    case "provider_handoff_unsupported":
      return detail
        ? `The selected provider cannot accept this thread: ${detail}`
        : "The selected provider cannot accept this thread's handoff.";
    case "thread_has_no_history":
      return "There is nothing to carry over: this thread has no history yet.";
    default:
      if (detail) return detail;
      return failure.code
        ? `Could not switch provider (${failure.code}).`
        : "Could not switch provider.";
  }
}
