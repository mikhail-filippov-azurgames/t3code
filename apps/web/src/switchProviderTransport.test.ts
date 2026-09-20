import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  OrchestrationDispatchCommandError,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  dispatchSwitchProviderTransport,
  type SwitchProviderDispatchRequest,
  type SwitchProviderDispatchRunner,
} from "./switchProviderTransport";

const environmentId = EnvironmentId.make("env-1");
const request: SwitchProviderDispatchRequest = {
  environmentId,
  input: {
    taskId: ThreadId.make("thread-1"),
    target: {
      providerInstanceId: ProviderInstanceId.make("codex-default"),
      driverKind: ProviderDriverKind.make("codex"),
      model: "gpt-5.3",
    },
    reason: "quota exhausted",
  },
};

describe("dispatchSwitchProviderTransport", () => {
  it("forwards the switch request to the environment dispatch and reports success", async () => {
    const seen: SwitchProviderDispatchRequest[] = [];
    const dispatch: SwitchProviderDispatchRunner = async (candidate) => {
      seen.push(candidate);
      return AsyncResult.success({ sequence: 12 });
    };

    await expect(dispatchSwitchProviderTransport(dispatch, request)).resolves.toEqual({
      status: "success",
    });
    expect(seen).toEqual([request]);
  });

  for (const code of ["provider_handoff_unsupported", "thread_has_no_history"] as const) {
    it(`propagates the engine failure code ${code} to the UI`, async () => {
      const dispatch: SwitchProviderDispatchRunner = async () =>
        AsyncResult.failure(
          Cause.fail(
            new OrchestratorMcpFailure({
              code,
              message: `engine refused: ${code}`,
            }),
          ),
        );

      await expect(dispatchSwitchProviderTransport(dispatch, request)).resolves.toEqual({
        status: "failure",
        code,
        message: `engine refused: ${code}`,
      });
    });
  }

  it("maps an authorization denial to capability_denied instead of success", async () => {
    const dispatch: SwitchProviderDispatchRunner = async () =>
      AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This client may not operate on the environment.",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );

    await expect(dispatchSwitchProviderTransport(dispatch, request)).resolves.toEqual({
      status: "failure",
      code: "capability_denied",
      message: "This client may not operate on the environment.",
    });
  });

  it("surfaces an authorised dispatch failure message without inventing a code", async () => {
    const dispatch: SwitchProviderDispatchRunner = async () =>
      AsyncResult.failure(
        Cause.fail(
          new OrchestrationDispatchCommandError({
            message: "Failed to dispatch orchestration command",
          }),
        ),
      );

    await expect(dispatchSwitchProviderTransport(dispatch, request)).resolves.toEqual({
      status: "failure",
      message: "Failed to dispatch orchestration command",
    });
  });
});
