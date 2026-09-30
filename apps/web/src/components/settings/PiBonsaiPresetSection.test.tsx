import * as Cause from "effect/Cause";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, type PiBonsaiPreset } from "@t3tools/contracts";

import { PiBonsaiPresetSection } from "./PiBonsaiPresetSection";
import { applyPiBonsaiPresetToProviderConfig } from "./PiBonsaiPresetSection.logic";

const mocks = vi.hoisted(() => ({
  detectCommand: Symbol("detect-pi-bonsai-preset"),
  detect: vi.fn(),
  pickFolder: vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { pickFolder: mocks.pickFolder } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { detectPiBonsaiPreset: mocks.detectCommand },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.detect,
}));
vi.mock("../ui/button", async () => {
  const React = await import("react");
  type Props = Omit<React.ComponentProps<"button">, "size"> & {
    readonly size?: string;
    readonly variant?: string;
  };
  return {
    Button: ({ children, size: _size, variant: _variant, ...props }: Props) =>
      React.createElement("button", props, children),
  };
});
vi.mock("./settingsLayout", async () => {
  const React = await import("react");
  type Props = {
    readonly title: React.ReactNode;
    readonly description?: React.ReactNode;
    readonly children?: React.ReactNode;
  };
  return {
    SettingsRow: ({ title, description, children }: Props) =>
      React.createElement(
        "section",
        null,
        React.createElement("h2", null, title),
        React.createElement("p", null, description),
        children,
      ),
  };
});

const environmentId = EnvironmentId.make("bonsai-test-environment");
const preset: PiBonsaiPreset = {
  executablePath: "C:/fixture/Bonsai-demo/bin/cuda/llama-server.exe",
  modelPath: "C:/fixture/Bonsai-demo/models/bonsai2-gguf/27B/Ternary-Bonsai-2-27B-PQ2_0.gguf",
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "bonsai-2-27b",
};

let renderers: Array<ReactTestRenderer> = [];

function success(value: PiBonsaiPreset | null) {
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

function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => textOf(candidate).includes(label));
  if (!button) throw new Error("Expected settings action button was not rendered.");
  return button;
}

async function renderSection(
  props: {
    readonly environmentId?: typeof environmentId;
    readonly onUsePreset?: (selected: PiBonsaiPreset) => void;
  } = {},
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PiBonsaiPresetSection
        environmentId={props.environmentId ?? environmentId}
        readOnly={false}
        onUsePreset={props.onUsePreset ?? (() => undefined)}
      />,
    );
  });
  renderers.push(renderer);
  return renderer;
}

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = findButton(renderer, label);
  await act(async () => {
    (button.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.detect.mockReset();
  mocks.detect.mockResolvedValue(success(null));
  mocks.pickFolder.mockReset();
});

afterEach(async () => {
  for (const renderer of renderers) {
    await act(async () => renderer.unmount());
  }
  renderers = [];
});

describe("PiBonsaiPresetSection", () => {
  it("validates the selected root and applies the endpoint, model alias, and managed paths", async () => {
    const savedConfigs: Array<Record<string, unknown>> = [];
    const onUsePreset = vi.fn((selected: PiBonsaiPreset) => {
      savedConfigs.push(applyPiBonsaiPresetToProviderConfig({ apiKey: "kept" }, selected));
    });
    mocks.pickFolder.mockResolvedValue("C:/fixture/Bonsai-demo");
    mocks.detect.mockResolvedValueOnce(success(null)).mockResolvedValueOnce(success(preset));

    const renderer = await renderSection({ onUsePreset });
    await clickButton(renderer, "Choose Bonsai folder");

    expect(mocks.pickFolder).toHaveBeenCalledWith({ targetEnvironmentId: environmentId });
    expect(mocks.detect).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: { rootPath: "C:/fixture/Bonsai-demo" },
    });
    expect(onUsePreset).toHaveBeenCalledExactlyOnceWith(preset);
    expect(savedConfigs[0]).toEqual({
      apiKey: "kept",
      inferenceServerProfiles: [
        {
          model: "ft3-local/bonsai-2-27b",
          baseUrl: "http://127.0.0.1:8080/v1",
          executablePath: preset.executablePath,
          modelPath: preset.modelPath,
        },
      ],
      inferenceServerAutoStart: true,
    });
    expect(textOf(renderer.root.findByType("p"))).toContain(
      "were added to this Pi provider configuration",
    );
  });

  it("leaves settings unchanged when the folder picker is cancelled", async () => {
    const onUsePreset = vi.fn();
    mocks.pickFolder.mockResolvedValue(null);

    const renderer = await renderSection({ onUsePreset });
    await clickButton(renderer, "Choose Bonsai folder");

    expect(mocks.detect).toHaveBeenCalledTimes(1);
    expect(onUsePreset).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("rejects an invalid selected folder without applying a preset", async () => {
    const onUsePreset = vi.fn();
    mocks.pickFolder.mockResolvedValue("C:/fixture/not-a-bonsai-install");
    mocks.detect.mockResolvedValueOnce(success(null)).mockResolvedValueOnce(success(null));

    const renderer = await renderSection({ onUsePreset });
    await clickButton(renderer, "Choose Bonsai folder");

    expect(onUsePreset).not.toHaveBeenCalled();
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toContain(
      "That folder must contain the llama-server executable and the Bonsai 2 27B GGUF model.",
    );
  });

  it("shows errors from the folder picker and selected-root validation", async () => {
    const onUsePreset = vi.fn();
    mocks.pickFolder.mockRejectedValueOnce(new Error("Folder dialog failed"));
    let renderer = await renderSection({ onUsePreset });
    await clickButton(renderer, "Choose Bonsai folder");
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Folder dialog failed");
    expect(onUsePreset).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    renderers = renderers.filter((candidate) => candidate !== renderer);
    mocks.detect.mockReset();
    mocks.detect
      .mockResolvedValueOnce(success(null))
      .mockResolvedValueOnce(failure("Host check failed"));
    mocks.pickFolder.mockResolvedValue("C:/fixture/Bonsai-demo");
    renderer = await renderSection({ onUsePreset });
    await clickButton(renderer, "Choose Bonsai folder");
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Host check failed");
    expect(textOf(renderer.root.findByType("p"))).not.toContain("Checking this FT3 host");
    expect(onUsePreset).not.toHaveBeenCalled();
  });

  it("reports an initial host-check error instead of claiming no preset was found", async () => {
    mocks.detect.mockResolvedValueOnce(failure("Host connection failed"));

    const renderer = await renderSection();

    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Host connection failed");
    expect(textOf(renderer.root.findByType("p"))).not.toContain("No Bonsai preset was detected.");
    expect(textOf(renderer.root.findByType("p"))).toContain("could not verify the Bonsai preset");
  });

  it("does not apply a folder result after the selected environment changes", async () => {
    const nextEnvironmentId = EnvironmentId.make("other-environment");
    const onUsePreset = vi.fn();
    let resolvePicker!: (rootPath: string | null) => void;
    mocks.pickFolder.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolvePicker = resolve;
      }),
    );

    const renderer = await renderSection({ onUsePreset });
    await clickButton(renderer, "Choose Bonsai folder");
    await act(async () => {
      renderer.update(
        <PiBonsaiPresetSection
          environmentId={nextEnvironmentId}
          readOnly={false}
          onUsePreset={onUsePreset}
        />,
      );
    });
    await act(async () => {
      resolvePicker("C:/fixture/Bonsai-demo");
      await Promise.resolve();
    });

    expect(onUsePreset).not.toHaveBeenCalled();
    expect(mocks.detect).not.toHaveBeenCalledWith({
      environmentId,
      input: { rootPath: "C:/fixture/Bonsai-demo" },
    });
  });
});
