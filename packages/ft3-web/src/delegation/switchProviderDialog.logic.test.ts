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

const threadId = ThreadId.make("thread-1");
const target = {
  providerInstanceId: ProviderInstanceId.make("codex-default"),
  driverKind: ProviderDriverKind.make("codex"),
  model: "gpt-5.3",
};

describe("canSwitchThreadProvider", () => {
  it("allows the switch for delegated subagent threads", () => {
    expect(
      canSwitchThreadProvider({
        lineage: { parentThreadId: ThreadId.make("parent-1") },
      }),
    ).toBe(true);
    expect(canSwitchThreadProvider({ lineage: { parentThreadId: null } })).toBe(false);
    expect(canSwitchThreadProvider({ lineage: null })).toBe(false);
    expect(canSwitchThreadProvider({})).toBe(false);
    expect(canSwitchThreadProvider(null)).toBe(false);
    expect(canSwitchThreadProvider(undefined)).toBe(false);
  });

  it("allows the switch for started threads with provider work behind them", () => {
    expect(canSwitchThreadProvider({ lineage: null, latestRun: { runId: "run-1" } })).toBe(true);
    expect(
      canSwitchThreadProvider({ lineage: null, latestUserMessageAt: "2026-01-01T00:00:00Z" }),
    ).toBe(true);
    expect(canSwitchThreadProvider({ lineage: null, runtime: { status: "idle" } })).toBe(true);
    expect(canSwitchThreadProvider({ lineage: null })).toBe(false);
  });

  it("keeps untouched draft threads hidden", () => {
    expect(
      canSwitchThreadProvider({
        lineage: { parentThreadId: null },
        latestRun: null,
        latestUserMessageAt: null,
        runtime: null,
      }),
    ).toBe(false);
  });
});

describe("resolveSwitchProviderReason", () => {
  it("defaults blank input so callers always get a reason", () => {
    expect(resolveSwitchProviderReason(null)).toBe(DEFAULT_SWITCH_PROVIDER_REASON);
    expect(resolveSwitchProviderReason(undefined)).toBe(DEFAULT_SWITCH_PROVIDER_REASON);
    expect(resolveSwitchProviderReason("   ")).toBe(DEFAULT_SWITCH_PROVIDER_REASON);
  });

  it("trims a provided reason", () => {
    expect(resolveSwitchProviderReason("  quota exhausted  ")).toBe("quota exhausted");
  });

  it("truncates overlong reasons to the field bound", () => {
    const long = "x".repeat(SWITCH_PROVIDER_REASON_MAX_LENGTH + 10);
    const resolved = resolveSwitchProviderReason(long);
    expect(resolved).toHaveLength(SWITCH_PROVIDER_REASON_MAX_LENGTH);
    expect(resolved).toBe(long.slice(0, SWITCH_PROVIDER_REASON_MAX_LENGTH));
  });
});

describe("buildSwitchProviderInput", () => {
  it("passes thread id and target through with the resolved reason", () => {
    expect(buildSwitchProviderInput({ threadId, target, reason: "quota exhausted" })).toEqual({
      threadId,
      target: {
        providerInstanceId: target.providerInstanceId,
        driverKind: target.driverKind,
        model: target.model,
      },
      reason: "quota exhausted",
    });
  });

  it("falls back to the default reason when none is given", () => {
    expect(buildSwitchProviderInput({ threadId, target }).reason).toBe(
      DEFAULT_SWITCH_PROVIDER_REASON,
    );
  });
});

describe("resolveSwitchProviderFailureMessage", () => {
  it("keeps the server reason text for provider_handoff_unsupported", () => {
    expect(
      resolveSwitchProviderFailureMessage({
        code: "provider_handoff_unsupported",
        message: "target lacks workspace access",
      }),
    ).toBe("The selected provider cannot accept this thread: target lacks workspace access");
  });

  it("explains provider_handoff_unsupported without server text", () => {
    expect(resolveSwitchProviderFailureMessage({ code: "provider_handoff_unsupported" })).toBe(
      "The selected provider cannot accept this thread's handoff.",
    );
  });

  it("explains thread_has_no_history", () => {
    expect(resolveSwitchProviderFailureMessage({ code: "thread_has_no_history" })).toBe(
      "There is nothing to carry over: this thread has no history yet.",
    );
  });

  it("falls back to the server message or code for unknown failures", () => {
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
  it("fails closed until the switch is reachable from the UI", async () => {
    await expect(
      missingSwitchProviderTransport({ threadId, target, reason: "x" }),
    ).rejects.toBeInstanceOf(SwitchProviderEngineUnavailableError);
  });
});
