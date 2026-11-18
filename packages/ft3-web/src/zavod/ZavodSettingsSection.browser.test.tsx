import { EnvironmentId } from "@t3tools/contracts";
import {
  ZavodRpcError,
  type ZavodCopyPersonalResult,
  type ZavodStatus,
} from "@t3tools/ft3-host/rpc-contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => ({
  canRead: true,
  canConnect: true,
  status: null as ZavodStatus | null,
  queryError: null as string | null,
  queryPending: false,
  providerInstances: {} as Record<string, { driver: "claudeAgent" | "codex" }>,
  settingsEnvironment: vi.fn(),
  query: vi.fn(),
  permission: vi.fn(),
  refresh: vi.fn(),
  connect: vi.fn(),
  copy: vi.fn(),
  copyCommand: {},
}));

vi.mock("./state.ts", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    zavodEnvironment: {
      detect: mocks.query,
      connect: {
        permissionAtom: (environmentId: EnvironmentId) => {
          mocks.permission(environmentId);
          return mocks.canConnect ? allowed : denied;
        },
      },
      // Both commands need providers:manage, so one flag drives them.
      copyPersonal: Object.assign(mocks.copyCommand, {
        permissionAtom: () => (mocks.canConnect ? allowed : denied),
      }),
    },
  };
});

vi.mock("~/state/session", () => ({ useEnvironmentScope: () => mocks.canRead }));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    environmentId: EnvironmentId,
    selector: (settings: { providerInstances: typeof mocks.providerInstances }) => unknown,
  ) => {
    mocks.settingsEnvironment(environmentId);
    return selector({ providerInstances: mocks.providerInstances });
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.status,
    error: mocks.queryError,
    isPending: mocks.queryPending,
    refresh: mocks.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.copyCommand ? mocks.copy : mocks.connect,
}));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsRow: ({ description, control }: { description: ReactNode; control: ReactNode }) => (
    <div>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

import { ZavodSettingsSection } from "./ZavodSettingsSection.tsx";

const environmentId = EnvironmentId.make("selected-environment");
const connectedInstances = {
  "zavod-claude": { driver: "claudeAgent" },
  "zavod-codex": { driver: "codex" },
} as const;
const copyPlan: ZavodCopyPersonalResult = {
  items: [
    { family: "claude", path: "skills/alpha", action: "create" },
    { family: "claude", path: "CLAUDE.md", action: "overwrite" },
    { family: "codex", path: "config.toml", action: "merge" },
  ],
  skipped: [{ family: "claude", path: ".claude.json:mcpServers.leaky", reason: "secret" }],
};
// Dialog buttons are clicked in code: this project loads no CSS, so the modal layer would cover them.
const press = (locator: { element(): Element }) =>
  act(() => (locator.element() as HTMLElement).click());
const textOf = (locator: { element(): Element }) => () => locator.element().textContent ?? "";
const copyFailure = (stage: ZavodRpcError["stage"]) => ({
  _tag: "Failure",
  cause: Cause.fail(new ZavodRpcError({ operation: "copy", stage })),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canRead = true;
  mocks.canConnect = true;
  mocks.status = {
    state: "off",
    baseUrl: "https://zavod.example/v1",
    baseUrlSource: "state",
    reason: null,
  };
  mocks.queryError = null;
  mocks.queryPending = false;
  mocks.providerInstances = {};
  mocks.connect.mockResolvedValue({
    _tag: "Success",
    value: { ...mocks.status, claudeInstanceId: "zavod-claude", codexInstanceId: "zavod-codex" },
  });
  mocks.copy.mockResolvedValue({ _tag: "Success", value: copyPlan });
});

describe("Zavod settings", () => {
  it.each(["on", "off", "mixed", "unsupported", "absent"] as const)(
    "renders %s with both provider permissions",
    async (state) => {
      mocks.status = {
        ...mocks.status!,
        state,
        reason:
          state === "mixed" || state === "unsupported" ? "Configuration needs attention." : null,
      };
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      if (state === "absent") {
        expect(screen.container.textContent).toBe("");
        mocks.canConnect = false;
        await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
        expect(screen.container.textContent).toBe("");
        return;
      }
      await expect.element(screen.getByRole("region", { name: "Zavod" })).toBeVisible();
      if (state === "on") {
        await expect.element(screen.getByText("Claude and Codex already use Zavod.")).toBeVisible();
      }
      const button = screen.getByRole("button", { name: "Connect Zavod" });
      if (state === "unsupported") await expect.element(button).toBeDisabled();
      else {
        await expect.element(button).toBeEnabled();
        await userEvent.click(button);
        expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
      }
      if (state === "mixed" || state === "unsupported")
        await expect.element(screen.getByText("Configuration needs attention.")).toBeVisible();
      mocks.canConnect = false;
      await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
      await expect.element(screen.getByRole("region", { name: "Zavod" })).toBeVisible();
      await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
    },
  );

  it("requires read permission before requesting status", async () => {
    mocks.canRead = false;
    await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
    expect(screen.container.textContent).toBe("");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("blocks duplicate connects and reads connected state from provider settings", async () => {
    let resolve!: (result: unknown) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect Zavod" }));
    await expect.element(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
    expect(mocks.query).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(mocks.permission).toHaveBeenCalledWith(environmentId);
    await act(() =>
      resolve({
        _tag: "Success",
        value: {
          ...mocks.status,
          claudeInstanceId: "zavod-claude",
          codexInstanceId: "zavod-codex",
        },
      }),
    );
    await expect.element(screen.getByRole("button", { name: "Connect Zavod" })).toBeEnabled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.providerInstances = {
      "zavod-claude": { driver: "claudeAgent" },
      "zavod-codex": { driver: "codex" },
    };
    await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
    await expect
      .element(screen.getByText("Claude and Codex go through Zavod instances."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    await act(() => resolve({ _tag: "Success", value: mocks.status }));
    mocks.status = { ...mocks.status!, state: "mixed", reason: "Configuration changed." };
    await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
    await expect.element(screen.getByText("Configuration changed.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    mocks.status = { ...mocks.status!, state: "off", reason: null };
    mocks.providerInstances = {};
    await screen.rerender(
      <ZavodSettingsSection environmentId={EnvironmentId.make("other-environment")} />,
    );
    await expect.element(screen.getByRole("button", { name: "Connect Zavod" })).toBeEnabled();
  });

  it.each([true, false])(
    "keeps the connected status after remount with manage=%s",
    async (canConnect) => {
      mocks.canConnect = canConnect;
      mocks.providerInstances = {
        "zavod-claude": { driver: "claudeAgent" },
        "zavod-codex": { driver: "codex" },
      };
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await screen.rerender(<ZavodSettingsSection key="reload" environmentId={environmentId} />);
      await expect
        .element(screen.getByText("Claude and Codex go through Zavod instances."))
        .toBeVisible();
      if (canConnect)
        await expect.element(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
      else await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
      expect(mocks.settingsEnvironment).toHaveBeenCalledWith(environmentId);
    },
  );

  it.each(["zavod-claude", "zavod-codex"])(
    "requires the pair when only %s remains",
    async (instanceId) => {
      mocks.providerInstances = { [instanceId]: { driver: "codex" } };
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await expect.element(screen.getByRole("button", { name: "Connect Zavod" })).toBeEnabled();
      mocks.providerInstances = {
        "zavod-claude": { driver: "claudeAgent" },
        "zavod-codex": { driver: "codex" },
      };
      await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
      await expect.element(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
      mocks.providerInstances = {};
      await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
      await expect.element(screen.getByRole("button", { name: "Connect Zavod" })).toBeEnabled();
    },
  );

  it("shows a recoverable connect error", async () => {
    mocks.connect.mockResolvedValue({ _tag: "Failure", cause: "private server details" });
    await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect Zavod" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "Could not connect Zavod. Check the provider configuration and try again.",
      );
    await expect.element(screen.getByRole("button", { name: "Connect Zavod" })).toBeEnabled();
    expect(screen.container.textContent).not.toContain("private server details");
  });

  it("shows loading and permits retry after a status failure", async () => {
    mocks.status = null;
    mocks.queryPending = true;
    await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
    await expect.element(screen.getByText("Checking Zavod configuration…")).toBeVisible();
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
    mocks.queryError = "private server details";
    mocks.queryPending = false;
    await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Zavod status" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.container.textContent).not.toContain("private server details");
  });
  describe("Copy personal settings", () => {
    it("is hidden until Zavod is connected and without permission", async () => {
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await expect
        .element(screen.getByRole("button", { name: "Copy personal settings" }))
        .not.toBeInTheDocument();
      mocks.providerInstances = connectedInstances;
      await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
      await expect
        .element(screen.getByRole("button", { name: "Copy personal settings" }))
        .toBeEnabled();
      mocks.canConnect = false;
      await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
      await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
    });

    it("shows the dry run and applies only after confirmation", async () => {
      mocks.providerInstances = connectedInstances;
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy personal settings" }));
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { dryRun: true },
      });
      const dialog = page.getByRole("alertdialog");
      await expect.element(dialog).toBeVisible();
      await expect.poll(textOf(dialog)).toContain("Claude · skills/alpha");
      await expect.poll(textOf(dialog)).toContain("Will be overwritten (1)");
      await expect
        .poll(textOf(dialog))
        .toContain(
          "Files with the same name are overwritten; nothing in the Zavod instance is deleted.",
        );
      await expect.poll(textOf(dialog)).toContain("Codex · config.toml");
      await expect
        .poll(textOf(dialog))
        .toContain(".claude.json:mcpServers.leaky (contains a secret)");

      await press(page.getByRole("button", { name: "Cancel" }));
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      expect(mocks.copy).toHaveBeenCalledOnce();

      await userEvent.click(screen.getByRole("button", { name: "Copy personal settings" }));
      await press(page.getByRole("button", { name: "Copy", exact: true }));
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      expect(mocks.copy).toHaveBeenCalledTimes(3);
      expect(mocks.copy).toHaveBeenLastCalledWith({ environmentId, input: { dryRun: false } });
      await expect.element(screen.getByText("Personal settings copied. 1 skipped.")).toBeVisible();
    });

    it("has nothing to confirm when the plan is empty", async () => {
      mocks.providerInstances = connectedInstances;
      mocks.copy.mockResolvedValue({ _tag: "Success", value: { items: [], skipped: [] } });
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy personal settings" }));
      await expect.element(screen.getByText("Nothing to copy.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Copy", exact: true })).toBeDisabled();
    });

    it.each([
      ["state", "Zavod is not ready. Connect Zavod, then copy personal settings again."],
      ["limit", "Your personal settings are too large to copy"],
      ["copy", "Could not check personal settings. Try again."],
    ] as const)("explains a %s failure of the check", async (stage, text) => {
      mocks.providerInstances = connectedInstances;
      mocks.copy.mockResolvedValue(copyFailure(stage));
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy personal settings" }));
      await expect.poll(textOf(screen.getByRole("alert"))).toContain(text);
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      expect(mocks.copy).toHaveBeenCalledOnce();
    });

    it("explains a failed apply and keeps the button usable", async () => {
      mocks.providerInstances = connectedInstances;
      mocks.copy
        .mockResolvedValueOnce({ _tag: "Success", value: copyPlan })
        .mockResolvedValueOnce(copyFailure("copy"));
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy personal settings" }));
      await press(page.getByRole("button", { name: "Copy", exact: true }));
      await expect
        .poll(textOf(screen.getByRole("alert")))
        .toContain("Could not finish copying personal settings.");
      await expect
        .element(screen.getByRole("button", { name: "Copy personal settings" }))
        .toBeEnabled();
    });

    it("hints at the button when the copy after the first connect failed", async () => {
      mocks.connect.mockResolvedValue({
        _tag: "Success",
        value: {
          ...mocks.status,
          claudeInstanceId: "zavod-claude",
          codexInstanceId: "zavod-codex",
          personalCopy: "failed",
        },
      });
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await userEvent.click(screen.getByRole("button", { name: "Connect Zavod" }));
      await expect
        .poll(textOf(screen.getByRole("status")))
        .toContain("personal settings were not copied");
      mocks.providerInstances = connectedInstances;
      await screen.rerender(<ZavodSettingsSection environmentId={environmentId} />);
      await expect
        .element(screen.getByRole("button", { name: "Copy personal settings" }))
        .toBeEnabled();
    });

    it("stays quiet when the first copy succeeded", async () => {
      mocks.connect.mockResolvedValue({
        _tag: "Success",
        value: {
          ...mocks.status,
          claudeInstanceId: "zavod-claude",
          codexInstanceId: "zavod-codex",
          personalCopy: "copied",
        },
      });
      await using screen = await render(<ZavodSettingsSection environmentId={environmentId} />);
      await userEvent.click(screen.getByRole("button", { name: "Connect Zavod" }));
      await expect.element(screen.getByRole("button", { name: "Connect Zavod" })).toBeEnabled();
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    });
  });
});
