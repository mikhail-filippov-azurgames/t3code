import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  kimiSessionSelectOptions,
  resolveKimiModeId,
} from "./KimiAcpSupport.ts";

const reasoningOption = {
  id: "thinking",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "max",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
    { value: "max", name: "Max" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

describe("buildKimiAcpSpawnInput", () => {
  it("uses the default Kimi ACP command", () => {
    expect(buildKimiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses a custom binary and preserves the environment", () => {
    expect(
      buildKimiAcpSpawnInput({ binaryPath: "C:\\Tools\\kimi.exe" }, "C:\\work", {
        KIMI_API_KEY: "secret",
      }),
    ).toEqual({
      command: "C:\\Tools\\kimi.exe",
      args: ["acp"],
      cwd: "C:\\work",
      env: { KIMI_API_KEY: "secret" },
    });
  });
});

describe("resolveKimiModeId", () => {
  it("maps every T3 runtime mode to a Kimi mode", () => {
    expect(
      resolveKimiModeId({ runtimeMode: "approval-required", interactionMode: undefined }),
    ).toBe("default");
    expect(
      resolveKimiModeId({ runtimeMode: "auto-accept-edits", interactionMode: undefined }),
    ).toBe("auto");
    expect(resolveKimiModeId({ runtimeMode: "auto", interactionMode: undefined })).toBe("auto");
    expect(resolveKimiModeId({ runtimeMode: "full-access", interactionMode: undefined })).toBe(
      "yolo",
    );
  });

  it("gives plan interaction mode priority over runtime permissions", () => {
    expect(resolveKimiModeId({ runtimeMode: "full-access", interactionMode: "plan" })).toBe("plan");
  });
});

describe("applyKimiAcpModelSelection", () => {
  it.effect("applies the model and advertised thinking option", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string]> = [];
      yield* applyKimiAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([reasoningOption]),
          setModel: (model) => Effect.sync(() => void calls.push(["model", model])),
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push([configId, String(value)]);
              return { configOptions: [reasoningOption] };
            }),
        },
        model: "k3.1-pro",
        selections: [{ id: "reasoningEffort", value: "High" }],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([
        ["model", "k3.1-pro"],
        ["thinking", "high"],
      ]);
    }),
  );

  it("flattens grouped ACP select options", () => {
    const grouped = {
      ...reasoningOption,
      options: [
        {
          group: "thinking",
          name: "Thinking levels",
          options: [
            { value: "low", name: "Low" },
            { value: "max", name: "Maximum" },
          ],
        },
      ],
    } satisfies EffectAcpSchema.SessionConfigOption;
    expect(kimiSessionSelectOptions(grouped).map((option) => option.value)).toEqual(["low", "max"]);
  });
});
