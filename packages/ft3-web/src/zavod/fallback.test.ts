import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePersonalFallback } from "./fallback.ts";

type Candidate = Parameters<typeof resolvePersonalFallback>[1][number];

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<Omit<Candidate, "instanceId" | "driver">> = {},
): Candidate {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    status: "ready",
    auth: { status: "authenticated" } as ServerProvider["auth"],
    models: [
      { slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null },
      {
        slug: "claude-sonnet-5-5",
        name: "Sonnet",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    ...overrides,
  };
}

const zavod = provider("claudeZavod", "claudeAgent", { displayName: "Zavod Claude" });
const thread = { instanceId: "claudeZavod", model: "claude-opus-5-5" };

describe("resolvePersonalFallback", () => {
  it("targets the personal instance of the same driver and keeps the model", () => {
    const personal = provider("claudeAgent", "claudeAgent", { displayName: "Claude" });
    const otherDriver = provider("codex", "codex");
    expect(resolvePersonalFallback(thread, [zavod, otherDriver, personal])).toEqual({
      target: {
        providerInstanceId: "claudeAgent",
        driverKind: "claudeAgent",
        model: "claude-opus-5-5",
      },
      displayName: "Claude",
    });
  });

  it("returns null when no instance of the same driver exists", () => {
    expect(resolvePersonalFallback(thread, [zavod, provider("codex", "codex")])).toBeNull();
  });

  it("skips disabled, unconfirmed and failing personal instances", () => {
    for (const overrides of [
      { enabled: false },
      { auth: { status: "unauthenticated" } as ServerProvider["auth"] },
      { auth: { status: "unknown" } as ServerProvider["auth"] },
      { status: "error" as const },
      { status: "disabled" as const },
    ]) {
      expect(
        resolvePersonalFallback(thread, [zavod, provider("claudeAgent", "claudeAgent", overrides)]),
      ).toBeNull();
    }
  });

  it("accepts an authenticated personal instance with a warning status", () => {
    const personal = provider("claudeAgent", "claudeAgent", { status: "warning" });
    expect(resolvePersonalFallback(thread, [zavod, personal])?.target.providerInstanceId).toBe(
      "claudeAgent",
    );
  });

  it("never targets another Zavod instance", () => {
    expect(
      resolvePersonalFallback(thread, [zavod, provider("zavod-claude", "claudeAgent")]),
    ).toBeNull();
  });

  it("falls back to the target default model when it lacks the thread model", () => {
    const personal = provider("claudeAgent", "claudeAgent");
    const result = resolvePersonalFallback({ ...thread, model: "claude-haiku-5-5" }, [
      zavod,
      personal,
    ]);
    expect(result?.target.model).toBe("claude-sonnet-5-5");
    expect(result?.displayName).toBe("claudeAgent");
  });
});
