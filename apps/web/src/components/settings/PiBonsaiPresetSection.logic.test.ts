import { describe, expect, it } from "vite-plus/test";
import { applyPiBonsaiPresetToProviderConfig } from "./PiBonsaiPresetSection.logic";

describe("applyPiBonsaiPresetToProviderConfig", () => {
  it("adds a model-specific managed profile and auto-start on explicit preset use", () => {
    const existingProfile = {
      model: "ft3-local/bonsai-2-8b",
      baseUrl: "http://127.0.0.1:8081/v1",
      executablePath: "C:/Bonsai/llama-server.exe",
      modelPath: "C:/Bonsai/bonsai-2-8b.gguf",
    };
    const currentConfig = {
      apiKey: "kept",
      customSetting: 1,
      inferenceServerAutoStart: false,
      inferenceServerProfiles: [existingProfile],
    };
    const preset = {
      executablePath: "C:/Bonsai/llama-server.exe",
      modelPath: "C:/Bonsai/bonsai-2-27b.gguf",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "bonsai-2-27b",
    };

    expect(applyPiBonsaiPresetToProviderConfig(currentConfig, preset)).toEqual({
      apiKey: "kept",
      customSetting: 1,
      inferenceServerProfiles: [
        existingProfile,
        {
          model: "ft3-local/bonsai-2-27b",
          baseUrl: "http://127.0.0.1:8080/v1",
          executablePath: "C:/Bonsai/llama-server.exe",
          modelPath: "C:/Bonsai/bonsai-2-27b.gguf",
        },
      ],
      inferenceServerAutoStart: true,
    });
    expect(currentConfig.inferenceServerAutoStart).toBe(false);
  });
});
