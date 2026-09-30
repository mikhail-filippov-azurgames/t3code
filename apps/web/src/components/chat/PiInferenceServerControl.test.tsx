import * as Cause from "effect/Cause";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EnvironmentId,
  PiSettings,
  ProviderInstanceId,
  type PiBonsaiPreset,
  type PiInferenceServerStatus,
} from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";

import { desktopLocalConnectionId } from "../../connection/desktopLocal";
import { PiInferenceServerControl } from "./PiInferenceServerControl";

const mocks = vi.hoisted(() => ({
  statusCommand: Symbol("pi-status"),
  startCommand: Symbol("pi-start"),
  stopCommand: Symbol("pi-stop"),
  detectCommand: Symbol("pi-detect-bonsai"),
  refreshCommand: Symbol("pi-refresh"),
  updateCommand: Symbol("update-settings"),
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  detect: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  pickFolder: vi.fn(),
  providerInstances: {} as Record<string, unknown>,
  environmentPresentation: null as unknown,
}));

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { pickFolder: mocks.pickFolder } }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_environmentId: unknown, selector: (settings: unknown) => unknown) =>
    selector({ providerInstances: mocks.providerInstances }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => mocks.environmentPresentation,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    piInferenceServerStatus: mocks.statusCommand,
    startPiInferenceServer: mocks.startCommand,
    stopPiInferenceServer: mocks.stopCommand,
    detectPiBonsaiPreset: mocks.detectCommand,
    refreshProviders: mocks.refreshCommand,
    updateSettings: mocks.updateCommand,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (command === mocks.statusCommand) return mocks.getStatus;
    if (command === mocks.startCommand) return mocks.start;
    if (command === mocks.stopCommand) return mocks.stop;
    if (command === mocks.detectCommand) return mocks.detect;
    if (command === mocks.refreshCommand) return mocks.refresh;
    if (command === mocks.updateCommand) return mocks.update;
    throw new Error("Unexpected Pi composer command.");
  },
}));
vi.mock("./ComposerControl", async () => {
  const React = await import("react");
  return {
    ComposerControl: ({
      children,
      size: _size,
      ...props
    }: React.ComponentProps<"button"> & {
      readonly size?: string;
    }) => React.createElement("button", props, children),
    ComposerControlIcon: () => null,
  };
});
vi.mock("../ui/button", async () => {
  const React = await import("react");
  return {
    Button: ({
      children,
      size: _size,
      variant: _variant,
      ...props
    }: React.ComponentProps<"button"> & {
      readonly size?: string;
      readonly variant?: string;
    }) => React.createElement("button", props, children),
  };
});
vi.mock("../ui/input", async () => {
  const React = await import("react");
  return {
    Input: (props: React.ComponentProps<"input">) => React.createElement("input", props),
  };
});
vi.mock("../ui/dialog", async () => {
  const React = await import("react");
  type Children = { readonly children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Children & { readonly open: boolean }) =>
      open ? React.createElement("div", null, children) : null,
    DialogPopup: ({ children }: Children) => React.createElement("section", null, children),
    DialogPanel: ({ children }: Children) => React.createElement("div", null, children),
    DialogHeader: ({ children }: Children) => React.createElement("header", null, children),
    DialogFooter: ({ children }: Children) => React.createElement("footer", null, children),
    DialogTitle: ({ children }: Children) => React.createElement("h1", null, children),
    DialogDescription: ({ children }: Children) => React.createElement("p", null, children),
  };
});
vi.mock("lucide-react", () => ({
  CircleIcon: () => null,
  FolderOpenIcon: () => null,
  PowerIcon: () => null,
  RefreshCwIcon: () => null,
}));

const environmentId = EnvironmentId.make("pi-bonsai-settings-test");
const instanceId = ProviderInstanceId.make("pi-bonsai-settings-instance");
const selectedModel = "ft3-local/bonsai-2-27b";
const preset: PiBonsaiPreset = {
  executablePath: "C:/fixture/Bonsai-demo/bin/cuda/llama-server.exe",
  modelPath: "C:/fixture/Bonsai-demo/models/bonsai2-gguf/27B/Ternary-Bonsai-2-27B-PQ2_0.gguf",
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "bonsai-2-27b",
};
const status: PiInferenceServerStatus = {
  instanceId,
  endpoint: "http://127.0.0.1:8080/v1",
  local: true,
  phase: "stopped",
  owner: "none",
  ready: false,
  canStart: true,
  canStop: false,
  pendingRestart: false,
  orphanedManagedEndpoint: null,
  usedByOtherInstances: false,
  progress: null,
  error: null,
  modelIds: [],
};

let renderers: ReactTestRenderer[] = [];

function success<T>(value: T) {
  return { _tag: "Success" as const, value };
}

function failure(message: string) {
  return { _tag: "Failure" as const, cause: Cause.fail(new Error(message)) };
}

function textOf(instance: ReactTestInstance): string {
  return instance.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root
    .findAllByType("button")
    .find(
      (candidate) => candidate.props["aria-label"] === label || textOf(candidate).includes(label),
    );
  if (!found) throw new Error(`Could not find button: ${label}`);
  return found;
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const target = button(renderer, label);
  await act(async () => {
    (target.props.onClick as (() => void) | undefined)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(config: unknown): Promise<ReactTestRenderer> {
  mocks.providerInstances = {
    [instanceId]: { driver: "pi", config },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PiInferenceServerControl
        environmentId={environmentId}
        instanceId={instanceId}
        threadId={null}
        model={selectedModel}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  renderers.push(renderer);
  return renderer;
}

beforeEach(() => {
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getStatus.mockReset().mockResolvedValue(success(status));
  mocks.start.mockReset().mockResolvedValue(success(status));
  mocks.stop.mockReset().mockResolvedValue(success(status));
  mocks.detect.mockReset();
  mocks.refresh.mockReset().mockResolvedValue(success(undefined));
  mocks.update.mockReset().mockResolvedValue(success(undefined));
  mocks.pickFolder.mockReset();
  mocks.providerInstances = {};
  mocks.environmentPresentation = {
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId,
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        label: "This device",
      }),
    },
  };
});

afterEach(async () => {
  for (const renderer of renderers) {
    await act(async () => renderer.unmount());
  }
  renderers = [];
  vi.unstubAllGlobals();
});

describe("Pi Bonsai composer settings", () => {
  it("auto-detects a 27B preset, keeps the 8B profile, and saves only on Apply", async () => {
    const eightB = {
      model: "ft3-local/bonsai-2-8b",
      executablePath: "C:/Bonsai/bin/cuda/llama-server.exe",
      modelPath: "C:/Bonsai/models/8B/Ternary-Bonsai-8B-PQ2_0.gguf",
      baseUrl: "http://127.0.0.1:8081/v1",
    };
    const original = Schema.decodeSync(PiSettings)({
      model: "bonsai-2-8b",
      inferenceServerModelPath: eightB.modelPath,
      inferenceServerProfiles: [eightB],
    });
    mocks.detect.mockResolvedValueOnce(success(preset));

    const renderer = await mount(original);
    await click(renderer, "Параметры сервера");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(mocks.detect).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {},
    });
    const formInputs = renderer.root.findAllByType("input");
    expect(formInputs.filter((input) => input.props.type === "number")).toHaveLength(7);
    expect(
      formInputs.filter(
        (input) => input.props.type !== "number" && input.props.type !== "checkbox",
      ),
    ).toHaveLength(0);
    expect(textOf(renderer.root)).toContain("Папка проверена");
    expect(mocks.update).not.toHaveBeenCalled();

    await click(renderer, "Применить");

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const updateInput = mocks.update.mock.calls[0]?.[0] as {
      readonly input: {
        readonly patch: {
          readonly piProviderInstanceConfigPatches: Record<
            string,
            { inferenceServerProfiles: unknown[] }
          >;
        };
      };
    };
    expect(
      updateInput.input.patch.piProviderInstanceConfigPatches[instanceId]?.inferenceServerProfiles,
    ).toEqual([
      eightB,
      {
        model: selectedModel,
        executablePath: preset.executablePath,
        modelPath: preset.modelPath,
        baseUrl: preset.baseUrl,
      },
    ]);
    expect(
      updateInput.input.patch.piProviderInstanceConfigPatches[instanceId]
        ?.inferenceServerProfiles[1],
    ).toMatchObject({ modelPath: expect.stringContaining("27B") });
  });

  it("uses an already saved 27B profile and does not ask for its folder again", async () => {
    const savedProfile = {
      model: selectedModel,
      executablePath: preset.executablePath,
      modelPath: preset.modelPath,
      baseUrl: preset.baseUrl,
    };
    const renderer = await mount({ inferenceServerProfiles: [savedProfile] });

    await click(renderer, "Параметры сервера");

    expect(mocks.detect).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("уже сохранён");
    expect(button(renderer, "Параметры сервера")).toBeDefined();
  });

  it("shows the folder picker for the local primary environment", async () => {
    mocks.detect.mockResolvedValueOnce(success(null));
    const renderer = await mount({});
    await click(renderer, "Параметры сервера");

    expect(button(renderer, "Выбрать папку Bonsai…")).toBeDefined();
  });

  it("hides the local picker for SSH and explains host-side setup", async () => {
    mocks.environmentPresentation = {
      entry: {
        target: new SshConnectionTarget({
          environmentId,
          connectionId: "ssh:remote",
          label: "Remote host",
        }),
      },
    };
    mocks.detect.mockResolvedValueOnce(success(null));
    const renderer = await mount({});
    await click(renderer, "Параметры сервера");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(
      renderer.root
        .findAllByType("button")
        .some((candidate) => textOf(candidate).includes("Выбрать папку Bonsai")),
    ).toBe(false);
    expect(textOf(renderer.root)).toContain("BONSAI_DEMO_HOME");
    expect(textOf(renderer.root)).toContain("целевому FT3-хосту");
    expect(mocks.detect).toHaveBeenCalledWith({ environmentId, input: {} });
  });

  it("routes a WSL folder choice through its desktop backend ID", async () => {
    mocks.environmentPresentation = {
      entry: {
        target: new BearerConnectionTarget({
          environmentId,
          connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
          label: "WSL (Ubuntu)",
        }),
      },
    };
    mocks.detect.mockResolvedValueOnce(success(null));
    mocks.pickFolder.mockResolvedValueOnce(null);
    const renderer = await mount({});
    await click(renderer, "Параметры сервера");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await click(renderer, "Выбрать папку Bonsai…");

    expect(mocks.pickFolder).toHaveBeenCalledWith({ targetEnvironmentId: "wsl:Ubuntu" });
  });

  it("keeps the draft unchanged when the picker is cancelled or the selected root is invalid", async () => {
    mocks.detect.mockResolvedValueOnce(success(null)).mockResolvedValueOnce(success(null));
    mocks.pickFolder
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("C:/fixture/not-a-bonsai-install");
    const renderer = await mount({});
    await click(renderer, "Параметры сервера");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    await click(renderer, "Выбрать папку Bonsai…");
    expect(mocks.detect).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();

    await click(renderer, "Выбрать папку Bonsai…");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(mocks.detect).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: { rootPath: "C:/fixture/not-a-bonsai-install" },
    });
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toContain(
      "именно для Bonsai 2 27B",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("surfaces host detection failures without inventing or saving a profile", async () => {
    mocks.detect.mockResolvedValueOnce(failure("Host verification failed"));
    const renderer = await mount({});
    await click(renderer, "Параметры сервера");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Host verification failed");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
