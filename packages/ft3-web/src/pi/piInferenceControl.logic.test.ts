import type { PiInferenceServerStatus } from "@t3tools/ft3-pi/rpc-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  piInferenceAction,
  piInferenceActionDisabled,
  piInferenceActionLabel,
  piInferenceEndpointLabel,
  piInferenceStatusLabel,
  piInferenceTone,
} from "./piInferenceControl.logic.ts";

const status = (overrides: Partial<PiInferenceServerStatus> = {}): PiInferenceServerStatus => ({
  instanceId: "pi",
  phase: "stopped",
  ready: false,
  endpoint: "http://127.0.0.1:8080/v1",
  model: "bonsai-2-27b",
  modelIds: [],
  owned: false,
  canStart: true,
  error: null,
  ...overrides,
});

describe("Pi inference control logic", () => {
  it("maps phases to tones", () => {
    expect(piInferenceTone(null)).toBe("off");
    expect(piInferenceTone(status())).toBe("off");
    expect(piInferenceTone(status({ phase: "starting" }))).toBe("starting");
    expect(piInferenceTone(status({ phase: "failed", error: "boom" }))).toBe("failed");
    expect(piInferenceTone(status({ phase: "ready", ready: true }))).toBe("ready");
  });

  it("starts only with a managed profile and stops only an owned process", () => {
    expect(piInferenceAction(status())).toBe("start");
    expect(piInferenceAction(status({ canStart: false }))).toBeNull();
    expect(piInferenceAction(status({ owned: true, ready: true }))).toBe("stop");
    expect(piInferenceAction(status({ owned: true, canStart: false }))).toBe("stop");
  });

  it("labels actions, including retry after failure", () => {
    expect(piInferenceActionLabel(status(), null)).toBe("Start");
    expect(piInferenceActionLabel(status({ phase: "failed" }), null)).toBe("Retry");
    expect(piInferenceActionLabel(status({ owned: true }), null)).toBe("Stop");
    expect(piInferenceActionLabel(status(), "start")).toBe("Starting…");
    expect(piInferenceActionLabel(status({ owned: true }), "stop")).toBe("Stopping…");
  });

  it("disables the action while pending, starting or unstartable", () => {
    expect(piInferenceActionDisabled(status(), null)).toBe(false);
    expect(piInferenceActionDisabled(status(), "start")).toBe(true);
    expect(piInferenceActionDisabled(status({ phase: "starting" }), null)).toBe(true);
    expect(piInferenceActionDisabled(status({ canStart: false }), null)).toBe(true);
    expect(piInferenceActionDisabled(status({ owned: true }), null)).toBe(false);
  });

  it("describes ready, external, off and failed states", () => {
    expect(piInferenceStatusLabel(status({ ready: true, phase: "ready", owned: true }))).toBe(
      "Inference server ready at http://127.0.0.1:8080.",
    );
    expect(
      piInferenceStatusLabel(status({ ready: true, phase: "ready", modelIds: ["bonsai-2-27b"] })),
    ).toBe("External inference server ready at http://127.0.0.1:8080. Model: bonsai-2-27b.");
    expect(piInferenceStatusLabel(status())).toBe("Inference server is off.");
    expect(piInferenceStatusLabel(status({ canStart: false }))).toBe(
      "No managed llama-server profile for the selected model.",
    );
    expect(piInferenceStatusLabel(status({ phase: "failed", error: "boom" }))).toBe("boom");
    expect(piInferenceStatusLabel(null, "network down")).toBe("network down");
  });

  it("reduces an endpoint to its origin and tolerates junk", () => {
    expect(piInferenceEndpointLabel("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
    expect(piInferenceEndpointLabel("not a url")).toBe("local endpoint");
    expect(piInferenceEndpointLabel("")).toBe("local endpoint");
  });
});
