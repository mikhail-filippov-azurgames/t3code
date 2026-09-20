import {
  EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import type {
  SwitchProviderInput,
  SwitchProviderResult,
} from "./components/switchProviderDialog.logic";

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export interface SwitchProviderDispatchRequest {
  readonly environmentId: EnvironmentId;
  readonly input: SwitchProviderInput;
}

/**
 * Runs one `thread.switch-provider` dispatch against an environment. Kept
 * structural (instead of taking the atom command directly) so the mapping
 * below stays unit-testable with a fake runner.
 */
export type SwitchProviderDispatchRunner = (
  request: SwitchProviderDispatchRequest,
) => Promise<AtomCommandResult<{ readonly sequence: number }, unknown>>;

/**
 * Default UI→engine transport for provider switches. The dispatch answers
 * synchronously: success carries the dispatch receipt, engine failures keep
 * their codes (provider_handoff_unsupported, thread_has_no_history, …), and
 * an authorization denial surfaces as capability_denied. Defects and
 * interruptions reject, matching the injected-transport contract the hook
 * already toasts.
 */
export async function dispatchSwitchProviderTransport(
  dispatch: SwitchProviderDispatchRunner,
  request: SwitchProviderDispatchRequest,
): Promise<SwitchProviderResult> {
  const result = await dispatch(request);
  if (result._tag === "Success") return { status: "success" };
  if (isAtomCommandInterrupted(result)) {
    throw new Error("The provider switch was interrupted before the engine answered.");
  }
  let failure: unknown;
  try {
    failure = squashAtomCommandFailure(result);
  } catch (defect) {
    throw defect;
  }
  if (isOrchestratorMcpFailure(failure)) {
    return { status: "failure", code: failure.code, message: failure.message };
  }
  if (isEnvironmentAuthorizationError(failure)) {
    return { status: "failure", code: "capability_denied", message: failure.message };
  }
  if (failure instanceof Error) {
    return { status: "failure", message: failure.message };
  }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return { status: "failure", message: failure.message };
  }
  return { status: "failure", message: "Could not switch provider." };
}
