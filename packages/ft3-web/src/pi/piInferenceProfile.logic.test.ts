import type { PiInferenceProfileSettings } from "@t3tools/ft3-pi/rpc-contracts";
import { describe, expect, it } from "vite-plus/test";

import { validatePiInferenceProfile } from "./piInferenceProfile.logic.ts";

const profile = (
  overrides: Partial<PiInferenceProfileSettings> = {},
): PiInferenceProfileSettings => ({
  model: "ft3-local/ternary-bonsai-8b",
  baseUrl: "http://127.0.0.1:8081/v1",
  executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
  modelPath: "C:\\Bonsai\\models\\bonsai-8b.gguf",
  gpuLayers: 48,
  contextSize: 81_920,
  parallel: 1,
  temperature: 1,
  topP: 0.95,
  topK: 20,
  minP: 0.05,
  flashAttention: true,
  cacheTypeK: "q4_0",
  cacheTypeV: "q4_0",
  jinja: true,
  reasoning: true,
  reasoningEffort: "medium",
  ...overrides,
});

describe("Pi inference profile validation", () => {
  it("accepts a complete loopback profile", () => {
    expect(validatePiInferenceProfile(profile())).toBeNull();
    expect(validatePiInferenceProfile(profile({ baseUrl: "http://localhost:8080/v1" }))).toBeNull();
  });

  it("requires the executable and model file", () => {
    expect(validatePiInferenceProfile(profile({ executablePath: " " }))).toMatch(/executable/);
    expect(validatePiInferenceProfile(profile({ modelPath: "" }))).toMatch(/model file/);
  });

  it("rejects endpoints that are not local plain HTTP", () => {
    expect(validatePiInferenceProfile(profile({ baseUrl: "http://example.com/v1" }))).toMatch(
      /loopback/,
    );
    expect(validatePiInferenceProfile(profile({ baseUrl: "https://127.0.0.1:8081/v1" }))).toMatch(
      /loopback/,
    );
    expect(validatePiInferenceProfile(profile({ baseUrl: "not a url" }))).toMatch(/loopback/);
  });

  it("bounds numeric launch parameters", () => {
    expect(validatePiInferenceProfile(profile({ contextSize: 256 }))).toMatch(/Context/);
    expect(validatePiInferenceProfile(profile({ gpuLayers: 1000 }))).toMatch(/GPU layers/);
    expect(validatePiInferenceProfile(profile({ parallel: 0 }))).toMatch(/Parallel slots/);
    expect(validatePiInferenceProfile(profile({ temperature: 3 }))).toMatch(/Temperature/);
    expect(validatePiInferenceProfile(profile({ topP: 1.5 }))).toMatch(/Top-p/);
    expect(validatePiInferenceProfile(profile({ topK: -1 }))).toMatch(/Top-k/);
    expect(validatePiInferenceProfile(profile({ minP: 2 }))).toMatch(/Min-p/);
  });
});
