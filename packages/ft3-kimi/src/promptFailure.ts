import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeAcpRequestError,
  type AcpSessionRuntimeService,
  type AcpSessionUpdate,
} from "@t3tools/provider-acp-registry/server";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const OUTPUT_UPDATE_KINDS = new Set<AcpSessionUpdate["sessionUpdate"]>([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "tool_call_content_chunk",
  "plan",
  "plan_update",
  "compaction_update",
  "compaction_summary_chunk",
]);

const isTurnOutputUpdate = (update: AcpSessionUpdate): boolean =>
  OUTPUT_UPDATE_KINDS.has(update.sessionUpdate);

const formatResetDelay = (resetsAt: string, nowMillis: number): string | undefined => {
  const resetMillis = Date.parse(resetsAt);
  if (!Number.isFinite(resetMillis)) return undefined;
  const remainingMinutes = Math.ceil((resetMillis - nowMillis) / 60_000);
  if (remainingMinutes <= 0) return "shortly";
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

const isExhausted = (window: ServerProviderUsageWindow): boolean => window.usedPercent >= 100;

const exhaustedWindow = (
  limits: ServerProviderUsageLimits,
): ServerProviderUsageWindow | undefined =>
  limits.windows.find((window) => window.kind === "session" && isExhausted(window)) ??
  limits.windows.find(isExhausted);

const AUTH_FAILURE_PATTERN =
  /sign-in token|kimi login|rejected the sign-in|sign in with `kimi login`/iu;

/**
 * ACP reports Kimi's exhausted quota as a successful empty `end_turn`, so the
 * only remaining signal is the plan usage endpoint.
 */
export function kimiEmptyTurnFailureMessage(
  limits: ServerProviderUsageLimits,
  nowMillis: number,
): string {
  const window = exhaustedWindow(limits);
  if (window !== undefined) {
    const remaining =
      window.resetsAt === undefined ? undefined : formatResetDelay(window.resetsAt, nowMillis);
    return `Kimi: ${window.label.toLowerCase()} limit exhausted${remaining === undefined ? "" : `, resets in ${remaining}`}.`;
  }
  const unavailableMessage = limits.unavailable?.message;
  if (unavailableMessage !== undefined && AUTH_FAILURE_PATTERN.test(unavailableMessage)) {
    return unavailableMessage.startsWith("Kimi")
      ? unavailableMessage
      : `Kimi: ${unavailableMessage}`;
  }
  return "Kimi: the turn ended without any response.";
}

export interface KimiPromptGuardOptions {
  readonly runtime: AcpSessionRuntimeService;
  readonly limits: Effect.Effect<ServerProviderUsageLimits>;
  readonly nowMillis?: Effect.Effect<number>;
}

/**
 * Kimi Code CLI 2.3.2 answers a failed LLM request with an empty, successful
 * `end_turn` instead of an ACP error. Wrap the runtime so an empty turn is
 * checked against plan usage and reported as a failed prompt.
 */
export const decorateKimiRuntime = (options: KimiPromptGuardOptions): AcpSessionRuntimeService => {
  const runtime = options.runtime;
  let sawOutput = false;

  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      runtime.handleSessionUpdate((notification) => {
        if (isTurnOutputUpdate(notification.update)) sawOutput = true;
        return handler(notification);
      }),
    prompt: Effect.fn("KimiRuntime.prompt")(function* (payload, promptOptions) {
      sawOutput = false;
      const result = yield* runtime.prompt(payload, promptOptions);
      if (result.stopReason !== "end_turn" || sawOutput) return result;

      const limits = yield* options.limits.pipe(Effect.catchCause(() => Effect.void));
      if (limits === undefined) {
        return yield* makeAcpRequestError("Kimi: the turn ended without any response.");
      }
      const nowMillis = yield* options.nowMillis ?? Clock.currentTimeMillis;
      return yield* makeAcpRequestError(kimiEmptyTurnFailureMessage(limits, nowMillis));
    }),
  };
};
