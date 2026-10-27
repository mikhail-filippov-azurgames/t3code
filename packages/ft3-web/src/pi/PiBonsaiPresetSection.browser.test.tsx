import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { PiBonsaiPreset } from "@t3tools/ft3-pi/rpc-contracts";

import { render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => ({
  detectTag: Symbol("detect-preset"),
  applyTag: Symbol("apply-preset"),
  detect: vi.fn(),
  apply: vi.fn(),
  pickFolder: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { pickFolder: mocks.pickFolder } }),
}));
vi.mock("./state.ts", () => ({
  piEnvironment: {
    detectBonsaiPreset: mocks.detectTag,
    applyBonsaiPreset: mocks.applyTag,
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => (command === mocks.detectTag ? mocks.detect : mocks.apply),
}));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    children,
  }: {
    readonly title: ReactNode;
    readonly description?: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  ),
}));

import { PiBonsaiPresetSection } from "./PiBonsaiPresetSection.tsx";

const environmentId = EnvironmentId.make("bonsai-environment");
const instanceId = ProviderInstanceId.make("pi");
const preset: PiBonsaiPreset = {
  executablePath: "C:/fixture/Bonsai-demo/bin/cuda/llama-server.exe",
  modelPath: "C:/fixture/Bonsai-demo/models/bonsai2-gguf/27B/Ternary-Bonsai-2-27B-PQ2_0.gguf",
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "bonsai-2-27b",
};

const success = <A,>(value: A) => ({ _tag: "Success" as const, value });
const failure = (message: string) => ({
  _tag: "Failure" as const,
  cause: Cause.fail(new Error(message)),
});

function renderSection(environment = environmentId, instance = instanceId) {
  return render(
    <PiBonsaiPresetSection environmentId={environment} instanceId={instance} readOnly={false} />,
    { router: false },
  );
}

describe("PiBonsaiPresetSection", () => {
  it("applies a detected preset to the selected Pi instance", async () => {
    mocks.detect.mockReset();
    mocks.detect.mockResolvedValue(success(preset));
    mocks.apply.mockReset();
    mocks.apply.mockResolvedValue(success(preset));

    await using screen = await renderSection();
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain("stable Bonsai model ID"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Use detected Bonsai preset" }));

    expect(mocks.apply).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId },
    });
    await vi.waitFor(() => expect(screen.container.querySelector("[role='alert']")).toBeNull());
  });

  it("validates a chosen folder and saves its preset", async () => {
    mocks.detect.mockReset();
    mocks.detect.mockResolvedValue(success(null));
    mocks.apply.mockReset();
    mocks.apply.mockResolvedValue(success(preset));
    mocks.pickFolder.mockReset();
    mocks.pickFolder.mockResolvedValue("C:/fixture/Bonsai-demo");

    await using screen = await renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Choose Bonsai folder" }));

    expect(mocks.pickFolder).toHaveBeenCalledWith({ targetEnvironmentId: environmentId });
    expect(mocks.apply).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, rootPath: "C:/fixture/Bonsai-demo" },
    });
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain(
        "saved to this Pi instance's managed inference profiles",
      ),
    );
  });

  it("rejects a folder without the Bonsai executable and model", async () => {
    mocks.detect.mockReset();
    mocks.detect.mockResolvedValue(success(null));
    mocks.apply.mockReset();
    mocks.apply.mockResolvedValue(success(null));
    mocks.pickFolder.mockReset();
    mocks.pickFolder.mockResolvedValue("C:/fixture/not-a-bonsai-install");

    await using screen = await renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Choose Bonsai folder" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toContain(
        "That folder must contain the llama-server executable and the Bonsai 2 27B GGUF model.",
      ),
    );
  });

  it("reports a host detection error instead of claiming no preset was found", async () => {
    mocks.detect.mockReset();
    mocks.detect.mockResolvedValue(failure("Host connection failed"));

    await using screen = await renderSection();

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toBe("Host connection failed"),
    );
    expect(screen.container.textContent).toContain("could not verify the Bonsai preset");
    expect(screen.container.textContent).not.toContain("No Bonsai preset was detected.");
  });

  it("does not save a folder result after the selected instance changes", async () => {
    let resolvePicker!: (rootPath: string | null) => void;
    mocks.detect.mockReset();
    mocks.detect.mockResolvedValue(success(null));
    mocks.apply.mockReset();
    mocks.apply.mockResolvedValue(success(preset));
    mocks.pickFolder.mockReset();
    mocks.pickFolder.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolvePicker = resolve;
      }),
    );

    await using screen = await renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Choose Bonsai folder" }));
    await screen.rerender(
      <PiBonsaiPresetSection
        environmentId={environmentId}
        instanceId={ProviderInstanceId.make("other-pi")}
        readOnly={false}
      />,
    );
    resolvePicker("C:/fixture/Bonsai-demo");

    await vi.waitFor(() => expect(mocks.pickFolder).toHaveBeenCalledTimes(1));
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
