import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import type {
  SwitchProviderInput,
  SwitchProviderTarget,
  SwitchProviderTransport,
} from "../components/switchProviderDialog.logic";
import { useSwitchThreadProvider } from "./useSwitchThreadProvider";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const target: SwitchProviderTarget = {
  providerInstanceId: ProviderInstanceId.make("codex-default"),
  driverKind: ProviderDriverKind.make("codex"),
  model: "gpt-5.3",
};

type AttemptFn = (
  ref: typeof threadRef,
  target: SwitchProviderTarget,
  reason?: string | null,
) => Promise<boolean>;

let renderer: ReactTestRenderer | null = null;
let attempt: AttemptFn | null = null;

function Probe({ transport }: { transport: SwitchProviderTransport }) {
  const { attemptSwitchProvider } = useSwitchThreadProvider({ transport });
  useLayoutEffect(() => {
    attempt = attemptSwitchProvider;
  });
  return null;
}

function renderProbe(transport: SwitchProviderTransport): AttemptFn {
  attempt = null;
  act(() => {
    renderer = create(<Probe transport={transport} />);
  });
  if (!attempt) throw new Error("probe did not expose attemptSwitchProvider");
  return attempt;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  attempt = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSwitchThreadProvider", () => {
  it("calls the engine transport with the menu-chosen target and reason", async () => {
    const seen: SwitchProviderInput[] = [];
    const transport: SwitchProviderTransport = async (input) => {
      seen.push(input);
      return { status: "success" };
    };
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
    const run = renderProbe(transport);

    let switched = false;
    await act(async () => {
      switched = await run(threadRef, target, "quota exhausted");
    });

    expect(switched).toBe(true);
    expect(seen).toEqual([
      {
        taskId: threadRef.threadId,
        target: {
          providerInstanceId: target.providerInstanceId,
          driverKind: target.driverKind,
          model: target.model,
        },
        reason: "quota exhausted",
      },
    ]);
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Provider switched" }));
  });

  it("surfaces the engine failure reason in a visible error toast", async () => {
    const transport: SwitchProviderTransport = async () => ({
      status: "failure",
      code: "provider_handoff_unsupported",
      message: "target lacks workspace access",
    });
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
    const run = renderProbe(transport);

    let switched = true;
    await act(async () => {
      switched = await run(threadRef, target, null);
    });

    expect(switched).toBe(false);
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to switch provider",
        description: expect.stringContaining("target lacks workspace access"),
      }),
    );
  });

  it("toasts a thrown transport failure instead of rejecting", async () => {
    const transport: SwitchProviderTransport = async () => {
      throw new Error("offline");
    };
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
    const run = renderProbe(transport);

    let switched = true;
    await act(async () => {
      switched = await run(threadRef, target, "quota exhausted");
    });

    expect(switched).toBe(false);
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to switch provider",
        description: "offline",
      }),
    );
  });

  it("ignores a concurrent duplicate attempt for the same thread", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = vi.fn<SwitchProviderTransport>(async () => {
      await pending;
      return { status: "success" };
    });
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
    const run = renderProbe(transport);

    await act(async () => {
      const first = run(threadRef, target);
      const second = run(threadRef, target);
      expect(await second).toBe(false);
      release();
      expect(await first).toBe(true);
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);
  });
});
