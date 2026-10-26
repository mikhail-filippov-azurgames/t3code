import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildKimiCapabilitiesFromConfigOptions,
  buildKimiModelsFromConfigOptions,
} from "./KimiProvider.ts";

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-code/kimi-for-coding",
    options: [
      { value: "kimi-code/kimi-for-coding", name: "Kimi for Coding" },
      { value: "k3.1-pro", name: "Kimi K3.1 Pro", description: "General reasoning" },
      { value: "k3.1-pro", name: "Duplicate" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "max",
    options: [
      {
        group: "thinking",
        name: "Available levels",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
      },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("Kimi ACP provider discovery", () => {
  it("builds models from configOptions, marks the current default and deduplicates ids", () => {
    const models = buildKimiModelsFromConfigOptions(configOptions);
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["kimi-code/kimi-for-coding", "Kimi for Coding", true],
      ["k3.1-pro", "Kimi K3.1 Pro", false],
    ]);
  });

  it("builds reasoning capabilities from grouped configOptions", () => {
    expect(buildKimiCapabilitiesFromConfigOptions(configOptions).optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Thinking",
        type: "select",
        currentValue: "max",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
          { id: "max", label: "Max", isDefault: true },
        ],
      },
    ]);
  });

  it("does not invent models or reasoning controls when ACP omits them", () => {
    expect(buildKimiModelsFromConfigOptions([])).toEqual([]);
    expect(buildKimiCapabilitiesFromConfigOptions([]).optionDescriptors).toEqual([]);
  });
});
