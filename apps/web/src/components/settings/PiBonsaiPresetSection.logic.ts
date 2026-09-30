import type { PiBonsaiPreset } from "@t3tools/contracts";

/** Apply a detected preset only in response to the user's explicit action. */
export function applyPiBonsaiPresetToProviderConfig(
  currentConfig: unknown,
  preset: PiBonsaiPreset,
): Record<string, unknown> {
  const config =
    currentConfig !== null && typeof currentConfig === "object" && !Array.isArray(currentConfig)
      ? (currentConfig as Record<string, unknown>)
      : {};

  return {
    ...config,
    inferenceServerProfiles: [
      ...(Array.isArray(config.inferenceServerProfiles)
        ? config.inferenceServerProfiles.filter(
            (profile) =>
              profile === null ||
              typeof profile !== "object" ||
              !("model" in profile) ||
              profile.model !== `ft3-local/${preset.model}`,
          )
        : []),
      {
        model: `ft3-local/${preset.model}`,
        baseUrl: preset.baseUrl,
        executablePath: preset.executablePath,
        modelPath: preset.modelPath,
      },
    ],
    inferenceServerAutoStart: true,
  };
}
