import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { PiInferenceProfileSettings } from "@t3tools/ft3-pi/rpc-contracts";

import { render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => {
  const profile: PiInferenceProfileSettings = {
    model: "ft3-local/ternary-bonsai-8b",
    baseUrl: "http://127.0.0.1:8081/v1",
    executablePath: "C:/fixture/Bonsai-demo/bin/cuda/llama-server.exe",
    modelPath: "C:/fixture/Bonsai-demo/models/ternary-gguf/8B/Ternary-Bonsai-8B-PQ2_0.gguf",
    gpuLayers: 99,
    contextSize: 32768,
    parallel: 1,
    temperature: 1,
    topP: 0.95,
    topK: 20,
    minP: 0.05,
    flashAttention: true,
    cacheTypeK: "q4_0" as const,
    cacheTypeV: "q4_0" as const,
    jinja: true,
    reasoning: true,
    reasoningEffort: "medium" as const,
  };
  return {
    profileTag: Symbol("profile"),
    saveTag: Symbol("save-profile"),
    profile,
    queryError: null as string | null,
    save: vi.fn(),
    refresh: vi.fn(),
  };
});

vi.mock("./state.ts", () => ({
  piEnvironment: {
    profile: () => mocks.profileTag,
    saveProfile: mocks.saveTag,
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.profile,
    error: mocks.queryError,
    refresh: mocks.refresh,
    isPending: false,
    isSuccess: true,
    dataUpdatedAt: 0,
    failure: null,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => (command === mocks.saveTag ? mocks.save : mocks.refresh),
}));

import { PiInferenceProfileDialog } from "./PiInferenceProfileDialog.tsx";

const environmentId = EnvironmentId.make("pi-environment");
const instanceId = ProviderInstanceId.make("pi");

function renderDialog(onOpenChange = vi.fn(), onSaved = vi.fn()) {
  return render(
    <PiInferenceProfileDialog
      environmentId={environmentId}
      instanceId={instanceId}
      model="ft3-local/ternary-bonsai-8b"
      open
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />,
    { router: false },
  );
}

describe("PiInferenceProfileDialog", () => {
  it("saves edited launch parameters for the selected model", async () => {
    mocks.save.mockReset();
    mocks.save.mockResolvedValue(AsyncResult.success(mocks.profile));
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();

    await using screen = await renderDialog(onOpenChange, onSaved);
    const context = screen.getByLabelText("Context (tokens)");
    await userEvent.clear(context);
    await userEvent.type(context, "16384");
    (screen.getByRole("button", { name: "Apply" }).element() as HTMLElement).click();

    expect(mocks.save).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        profile: { ...mocks.profile, contextSize: 16384 },
      },
    });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("blocks a non-loopback endpoint before calling the server", async () => {
    mocks.save.mockReset();
    const onOpenChange = vi.fn();

    await using screen = await renderDialog(onOpenChange);
    const endpoint = screen.getByLabelText("Loopback endpoint");
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, "http://example.com/v1");
    (screen.getByRole("button", { name: "Apply" }).element() as HTMLElement).click();

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toContain(
        "The inference endpoint must use HTTP on a loopback address.",
      ),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
