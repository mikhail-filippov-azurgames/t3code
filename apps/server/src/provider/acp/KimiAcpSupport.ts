import {
  type KimiSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const KIMI_DEFAULT_MODEL_SLUG = "kimi-code/kimi-for-coding";

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: Pick<KimiSettings, "binaryPath"> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: Pick<KimiSettings, "binaryPath"> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: "login",
        resumeMethod: "resume",
        cancelBehavior: "wait-for-prompt",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export interface KimiSessionSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export function kimiSessionSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<KimiSessionSelectOption> {
  if (option?.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
            ...(entry.description ? { description: entry.description } : {}),
          },
        ]
      : entry.options.map((nested) => ({
          value: nested.value.trim(),
          name: nested.name.trim(),
          ...(nested.description ? { description: nested.description } : {}),
        })),
  );
}

export function findKimiReasoningConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) =>
      option.type === "select" &&
      (option.category === "thought_level" ||
        option.id === "thinking" ||
        option.id === "reasoning" ||
        option.id === "reasoningEffort"),
  );
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option" | "session/set_model";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model) {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, method: "session/set_model" })));
    }

    const requested =
      getProviderOptionStringSelectionValue(input.selections, "reasoningEffort") ??
      getProviderOptionStringSelectionValue(input.selections, "reasoning");
    if (!requested) return;
    const reasoningOption = findKimiReasoningConfigOption(yield* input.runtime.getConfigOptions);
    if (!reasoningOption || reasoningOption.type !== "select") return;
    const normalized = requested.trim().toLowerCase();
    const selected = kimiSessionSelectOptions(reasoningOption).find(
      (option) =>
        option.value.toLowerCase() === normalized || option.name.toLowerCase() === normalized,
    );
    if (!selected) return;
    yield* input.runtime
      .setConfigOption(reasoningOption.id, selected.value)
      .pipe(
        Effect.mapError((cause) => input.mapError({ cause, method: "session/set_config_option" })),
      );
  });
}

export function resolveKimiModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): string {
  if (input.interactionMode === "plan") return "plan";
  switch (input.runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto":
    case "auto-accept-edits":
      return "auto";
    case "approval-required":
      return "default";
  }
}
