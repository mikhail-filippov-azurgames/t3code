import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type PiInferenceServerStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSelectedPiProviderStatus,
  selectedPiStatusKey,
} from "./useSelectedPiProviderStatus";
import { getProviderStatusBannerKey, shouldShowProviderStatusBanner } from "./ProviderStatusBanner";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi-default"),
  driver: ProviderDriverKind.make("pi"),
  displayName: "Pi",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "warning",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-27T00:00:00.000Z",
  message: "HTTP /health is not responding yet at 127.0.0.1:8081.",
  models: [],
  slashCommands: [],
  skills: [],
};
const selectedStatus: PiInferenceServerStatus = {
  instanceId: provider.instanceId,
  endpoint: "http://127.0.0.1:8080",
  local: true,
  phase: "ready",
  owner: "ft3",
  ready: true,
  canStart: true,
  canStop: true,
  pendingRestart: false,
  usedByOtherInstances: false,
  progress: null,
  error: null,
  modelIds: ["bonsai-2-27b"],
};

describe("selected Pi provider status", () => {
  const key = "environment\u0000pi-default\u0000ft3-local/bonsai-2-27b";
  const model = "ft3-local/bonsai-2-27b";

  it("uses the selected 27B endpoint rather than a failed default 8B endpoint", () => {
    expect(selectedPiStatusKey(EnvironmentId.make("environment"), provider, model)).toBe(key);
    expect(
      resolveSelectedPiProviderStatus(provider, model, { key, status: selectedStatus }, key)
        ?.status,
    ).toBe("ready");
    expect(resolveSelectedPiProviderStatus(provider, model, null, key)).toBeNull();
    expect(
      resolveSelectedPiProviderStatus(
        { ...provider, installed: false, message: "Checking bundled Pi runtime..." },
        model,
        null,
        key,
      ),
    ).toBeNull();
  });

  it("does not show Pi server status or probe it for a cloud model left by a provider switch", () => {
    expect(
      selectedPiStatusKey(EnvironmentId.make("environment"), provider, "gpt-5.6-sol"),
    ).toBeNull();
    expect(resolveSelectedPiProviderStatus(provider, "gpt-5.6-sol", null, null)).toBeNull();
    expect(
      resolveSelectedPiProviderStatus(
        provider,
        "gpt-5.6-sol",
        {
          key: "environment\u0000pi-default\u0000gpt-5.6-sol",
          error:
            "Configure a managed llama-server profile for the selected Pi model (gpt-5.6-sol).",
        },
        null,
      ),
    ).toBeNull();
  });

  it("keeps a real selected-model failure visible and scopes dismissal by model", () => {
    const failed = resolveSelectedPiProviderStatus(
      provider,
      model,
      {
        key,
        status: {
          ...selectedStatus,
          ready: false,
          phase: "stopped",
          error: "HTTP /health is not responding yet.",
        },
      },
      key,
    );
    expect(failed?.message).toContain("/health is not responding");
    const dismissal = getProviderStatusBannerKey(failed, model);
    expect(shouldShowProviderStatusBanner(failed, dismissal, model)).toBe(false);
    expect(shouldShowProviderStatusBanner(failed, dismissal, "ft3-local/bonsai-2-8b")).toBe(true);
  });

  it("does not replace a Pi runtime error with a healthy endpoint", () => {
    const brokenRuntime = {
      ...provider,
      status: "error" as const,
      message: "Pi runtime failed to launch.",
    };
    expect(
      resolveSelectedPiProviderStatus(brokenRuntime, model, { key, status: selectedStatus }, key),
    ).toBe(brokenRuntime);
  });
});
