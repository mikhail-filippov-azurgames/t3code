import type { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/**
 * Client-side contract for the thread-menu "Switch provider" entry point.
 * Mirrors the engine `switch_provider` input (`OrchestratorMcpSwitchProviderInput`)
 * so the UI collects exactly what the engine needs: the delegated thread
 * (taskId), the target provider/model, and a reason. The default web transport
 * dispatches this input through the environment command; alternate surfaces
 * and tests may inject `SwitchProviderTransport`.
 */

export interface SwitchProviderTarget {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
}

export interface SwitchProviderInput {
  readonly taskId: ThreadId;
  readonly target: SwitchProviderTarget;
  /** Always non-empty: the engine rejects an empty reason. */
  readonly reason: string;
}

/** Engine bound for `BoundedReason` (non-empty, max 2_000 chars). */
export const SWITCH_PROVIDER_REASON_MAX_LENGTH = 2_000;

/** Used when the user leaves the optional reason field blank. */
export const DEFAULT_SWITCH_PROVIDER_REASON = "Switched from the thread menu.";

/**
 * The UI reason field is optional, but the engine requires a non-empty
 * reason — blank input falls back to the default. Overlong input is
 * truncated to the engine bound instead of failing validation.
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
  readonly taskId: ThreadId;
  readonly target: SwitchProviderTarget;
  readonly reason?: string | null;
}): SwitchProviderInput {
  return {
    taskId: input.taskId,
    target: {
      providerInstanceId: input.target.providerInstanceId,
      driverKind: input.target.driverKind,
      model: input.target.model,
    },
    reason: resolveSwitchProviderReason(input.reason),
  };
}

/**
 * The menu entry is visible only where the engine switch is available:
 * delegated threads carry a `delegationParent` lineage, and ordinary
 * threads with a provider session switch through their own scope (the
 * engine refuses session-less threads, which have no provider to switch
 * from). Provider-internal subagents have neither, so they stay hidden.
 * Optional so shells from older servers still decode — absent means not
 * switchable.
 */
export function canSwitchThreadProvider(
  thread:
    | {
        readonly delegationParent?: { readonly parentThreadId: unknown } | null | undefined;
        readonly session?: { readonly providerInstanceId?: unknown } | null | undefined;
      }
    | null
    | undefined,
): boolean {
  if (thread?.delegationParent != null) return true;
  return thread?.session !== null && thread?.session !== undefined;
}

export type SwitchProviderResult =
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly code?: string; readonly message: string };

/**
 * Delivers a switch request to the engine. The web hook uses the
 * `thread.switch-provider` environment command by default; callers can inject
 * another transport for tests or alternate clients.
 */
export type SwitchProviderTransport = (input: SwitchProviderInput) => Promise<SwitchProviderResult>;

export class SwitchProviderEngineUnavailableError extends Error {
  constructor() {
    super(
      "Switching providers is not available yet: this environment's server does not expose the provider switch to the UI.",
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
 * Engine failures must surface visibly: the toast always includes the
 * engine's own reason text when one is present.
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
