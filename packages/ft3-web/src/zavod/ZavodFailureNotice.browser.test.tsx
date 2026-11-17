import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";

const environmentId = EnvironmentId.make("env-1");

const mocks = vi.hoisted(() => ({
  providers: [] as unknown[],
  modelSelection: { instanceId: "claudeZavod", model: "claude-opus-5-5" },
  toast: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => ({ modelSelection: mocks.modelSelection }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentProviders: () => new Map([["env-1", mocks.providers]]),
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("~/state/use-orchestration-command", () => ({ useOrchestrationCommand: () => vi.fn() }));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { ZavodFailureNotice, zavodFailureNoticeText } from "./ZavodFailureNotice.tsx";

const threadRef: ScopedThreadRef = { environmentId, threadId: ThreadId.make("thread-1") };

function provider(instanceId: string, displayName: string) {
  return {
    instanceId,
    driver: "claudeAgent",
    displayName,
    enabled: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers = [provider("claudeZavod", "Zavod Claude"), provider("claudeAgent", "Claude")];
});

describe("ZavodFailureNotice", () => {
  it.each(["unavailable", "model_access_denied", "transient", "rate_limited"] as const)(
    "explains %s and keeps the raw error behind disclosure",
    async (kind) => {
      await using screen = await render(
        <ZavodFailureNotice threadRef={threadRef} kind={kind} error="raw provider error" />,
      );
      const text = zavodFailureNoticeText(kind);
      await expect.element(screen.getByText(text.title)).toBeVisible();
      await expect.element(screen.getByText(text.detail)).toBeVisible();
      await expect.element(screen.getByText("raw provider error")).not.toBeVisible();
      await userEvent.click(screen.getByText("Show error details"));
      await expect.element(screen.getByText("raw provider error")).toBeVisible();
    },
  );

  it("switches the thread to the personal instance", async () => {
    const transport = vi.fn(async () => ({ status: "success" as const }));
    await using screen = await render(
      <ZavodFailureNotice
        threadRef={threadRef}
        kind="unavailable"
        error="Connection error."
        transport={transport}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));
    expect(transport).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
      target: {
        providerInstanceId: "claudeAgent",
        driverKind: "claudeAgent",
        model: "claude-opus-5-5",
      },
      reason: "Zavod failure fallback.",
    });
  });

  it("shows no switch button without a personal instance", async () => {
    mocks.providers = [provider("claudeZavod", "Zavod Claude")];
    const onDismiss = vi.fn();
    await using screen = await render(
      <ZavodFailureNotice
        threadRef={threadRef}
        kind="transient"
        error="auth_unavailable"
        onDismiss={onDismiss}
      />,
    );
    await expect.element(screen.getByRole("button", { name: /Switch to/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
