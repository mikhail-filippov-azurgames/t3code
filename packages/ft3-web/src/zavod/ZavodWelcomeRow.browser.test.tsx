import { EnvironmentId } from "@t3tools/contracts";
import type { ZavodStatus } from "@t3tools/ft3-host/rpc-contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => ({
  canRead: true,
  canConnect: true,
  status: null as ZavodStatus | null,
  queryError: null as string | null,
  queryPending: false,
  providerInstances: {} as Record<string, { driver: "claudeAgent" | "codex" }>,
  query: vi.fn(),
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
      connect: { permissionAtom: () => (mocks.canConnect ? allowed : denied) },
      copyPersonal: Object.assign(mocks.copyCommand, {
        permissionAtom: () => (mocks.canConnect ? allowed : denied),
      }),
    },
  };
});

vi.mock("~/state/session", () => ({ useEnvironmentScope: () => mocks.canRead }));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: { providerInstances: typeof mocks.providerInstances }) => unknown,
  ) => selector({ providerInstances: mocks.providerInstances }),
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

import { ZavodWelcomeRow } from "./ZavodWelcomeRow.tsx";

const environmentId = EnvironmentId.make("selected-environment");
const connectedInstances = {
  "zavod-claude": { driver: "claudeAgent" },
  "zavod-codex": { driver: "codex" },
} as const;

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
});

describe("Zavod welcome row", () => {
  it.each(["absent", "error", "pending", "unreadable"] as const)(
    "shows nothing when Zavod is %s",
    async (kind) => {
      if (kind === "absent") mocks.status = { ...mocks.status!, state: "absent" };
      if (kind === "error") mocks.queryError = "private server details";
      if (kind === "pending") {
        mocks.status = null;
        mocks.queryPending = true;
      }
      if (kind === "unreadable") mocks.canRead = false;
      await using screen = await render(
        <ZavodWelcomeRow environmentId={environmentId} onConnected={vi.fn()} />,
      );
      expect(screen.container.textContent).toBe("");
      expect(mocks.query).toHaveBeenCalledTimes(kind === "unreadable" ? 0 : 1);
    },
  );

  it("connects and tells the welcome page to reload the agents", async () => {
    const onConnected = vi.fn();
    await using screen = await render(
      <ZavodWelcomeRow environmentId={environmentId} onConnected={onConnected} />,
    );
    await expect.element(screen.getByText("Zavod", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Connect Claude and Codex through Zavod.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Connect Zavod" }));
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
    await expect.poll(() => onConnected.mock.calls.length).toBe(1);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("does not reload the agents after a failed connect", async () => {
    const onConnected = vi.fn();
    mocks.connect.mockResolvedValue({ _tag: "Failure", cause: "private server details" });
    await using screen = await render(
      <ZavodWelcomeRow environmentId={environmentId} onConnected={onConnected} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Zavod" }));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain("private server details");
  });

  it.each(["mixed", "unsupported"] as const)(
    "disables the button and says why for %s",
    async (state) => {
      mocks.status = { ...mocks.status!, state, reason: "Configuration needs attention." };
      await using screen = await render(
        <ZavodWelcomeRow environmentId={environmentId} onConnected={vi.fn()} />,
      );
      await expect.element(screen.getByText("Configuration needs attention.")).toBeVisible();
      const button = screen.getByRole("button", { name: "Connect Zavod" });
      if (state === "unsupported") await expect.element(button).toBeDisabled();
      else await expect.element(button).toBeEnabled();
    },
  );

  it("offers reconnect and copy once connected", async () => {
    mocks.providerInstances = connectedInstances;
    await using screen = await render(
      <ZavodWelcomeRow environmentId={environmentId} onConnected={vi.fn()} />,
    );
    await expect
      .element(screen.getByText("Claude and Codex go through Zavod instances."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    await expect
      .element(screen.getByRole("button", { name: "Copy personal settings" }))
      .toBeEnabled();
  });

  it("shows only the status without providers:manage", async () => {
    mocks.canConnect = false;
    mocks.providerInstances = connectedInstances;
    await using screen = await render(
      <ZavodWelcomeRow environmentId={environmentId} onConnected={vi.fn()} />,
    );
    await expect
      .element(screen.getByText("Claude and Codex go through Zavod instances."))
      .toBeVisible();
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  });
});
