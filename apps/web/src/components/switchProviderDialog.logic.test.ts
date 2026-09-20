import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSwitchProviderInput,
  canSwitchThreadProvider,
  DEFAULT_SWITCH_PROVIDER_REASON,
  missingSwitchProviderTransport,
  resolveSwitchProviderFailureMessage,
  resolveSwitchProviderReason,
  SWITCH_PROVIDER_REASON_MAX_LENGTH,
  SwitchProviderEngineUnavailableError,
} from "./switchProviderDialog.logic";

const taskId = ThreadId.make("thread-1");
const target = {
  providerInstanceId: ProviderInstanceId.make("codex-default"),
  driverKind: ProviderDriverKind.make("codex"),
  model: "gpt-5.3",
};

describe("canSwitchThreadProvider", () => {
  it("allows the switch for delegated threads", () => {
    expect(canSwitchThreadProvider({ delegationParent: { parentThreadId: "parent-1" } })).toBe(
      true,
    );
    expect(canSwitchThreadProvider({ delegationParent: null })).toBe(false);
    expect(canSwitchThreadProvider({})).toBe(false);
    expect(canSwitchThreadProvider(null)).toBe(false);
    expect(canSwitchThreadProvider(undefined)).toBe(false);
  });

  it("allows the switch for ordinary threads with a provider session", () => {
    expect(
      canSwitchThreadProvider({
        delegationParent: null,
        session: { providerInstanceId: "codex_one" },
      }),
    ).toBe(true);
    expect(canSwitchThreadProvider({ delegationParent: null, session: null })).toBe(false);
    expect(canSwitchThreadProvider({ session: null })).toBe(false);
  });

  it("keeps provider-internal subagents hidden", () => {
    expect(canSwitchThreadProvider({ delegationParent: null, session: undefined })).toBe(false);
  });
});

describe("resolveSwitchProviderReason", () => {
  it("defaults blank input so the engine always gets a reason", () => {
    expect(resolveSwitchProviderReason(null)).toBe(DEFAULT_SWITCH_PROVIDER_REASON);
    expect(resolveSwitchProviderReason(undefined)).toBe(DEFAULT_SWITCH_PROVIDER_REASON);
    expect(resolveSwitchProviderReason("   ")).toBe(DEFAULT_SWITCH_PROVIDER_REASON);
  });

  it("trims a provided reason", () => {
    expect(resolveSwitchProviderReason("  quota exhausted  ")).toBe("quota exhausted");
  });

  it("truncates overlong reasons to the engine bound", () => {
    const long = "x".repeat(SWITCH_PROVIDER_REASON_MAX_LENGTH + 10);
    const resolved = resolveSwitchProviderReason(long);
    expect(resolved).toHaveLength(SWITCH_PROVIDER_REASON_MAX_LENGTH);
    expect(resolved).toBe(long.slice(0, SWITCH_PROVIDER_REASON_MAX_LENGTH));
  });
});

describe("buildSwitchProviderInput", () => {
  it("passes task id and target through with the resolved reason", () => {
    expect(buildSwitchProviderInput({ taskId, target, reason: "quota exhausted" })).toEqual({
      taskId,
      target: {
        providerInstanceId: target.providerInstanceId,
        driverKind: target.driverKind,
        model: target.model,
      },
      reason: "quota exhausted",
    });
  });

  it("falls back to the default reason when none is given", () => {
    expect(buildSwitchProviderInput({ taskId, target }).reason).toBe(
      DEFAULT_SWITCH_PROVIDER_REASON,
    );
  });
});

describe("resolveSwitchProviderFailureMessage", () => {
  it("keeps the engine reason text for provider_handoff_unsupported", () => {
    expect(
      resolveSwitchProviderFailureMessage({
        code: "provider_handoff_unsupported",
        message: "target lacks workspace access",
      }),
    ).toBe("The selected provider cannot accept this thread: target lacks workspace access");
  });

  it("explains provider_handoff_unsupported without engine text", () => {
    expect(resolveSwitchProviderFailureMessage({ code: "provider_handoff_unsupported" })).toBe(
      "The selected provider cannot accept this thread's handoff.",
    );
  });

  it("explains thread_has_no_history", () => {
    expect(resolveSwitchProviderFailureMessage({ code: "thread_has_no_history" })).toBe(
      "There is nothing to carry over: this thread has no history yet.",
    );
  });

  it("falls back to the engine message or code for unknown failures", () => {
    expect(
      resolveSwitchProviderFailureMessage({ code: "orchestration_error", message: "boom" }),
    ).toBe("boom");
    expect(resolveSwitchProviderFailureMessage({ code: "orchestration_error" })).toBe(
      "Could not switch provider (orchestration_error).",
    );
    expect(resolveSwitchProviderFailureMessage({})).toBe("Could not switch provider.");
  });
});

describe("missingSwitchProviderTransport", () => {
  it("fails closed until the engine switch is reachable from the UI", async () => {
    await expect(
      missingSwitchProviderTransport({ taskId, target, reason: "x" }),
    ).rejects.toBeInstanceOf(SwitchProviderEngineUnavailableError);
  });
});
