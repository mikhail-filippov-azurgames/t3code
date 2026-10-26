import type {
  CustomModelSetting,
  KimiSettings,
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  KIMI_DEFAULT_MODEL_SLUG,
  findKimiReasoningConfigOption,
  kimiSessionSelectOptions,
  makeKimiAcpRuntime,
} from "../acp/KimiAcpSupport.ts";
import { probeKimiUsageLimits } from "./kimiUsageLimits.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_PROBE_TIMEOUT_MS = 15_000;
const USAGE_PROBE_TIMEOUT_MS = 10_000;

const KIMI_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIMI_DEFAULT_MODEL_SLUG,
    name: "Kimi for Coding",
    isDefault: true,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function kimiModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildKimiCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ModelCapabilities {
  const reasoning = findKimiReasoningConfigOption(configOptions);
  if (!reasoning || reasoning.type !== "select") return EMPTY_CAPABILITIES;
  const options = kimiSessionSelectOptions(reasoning).map((option) => ({
    value: option.value,
    label: option.name || option.value,
    ...(option.description ? { description: option.description } : {}),
    ...(option.value === reasoning.currentValue ? { isDefault: true } : {}),
  }));
  return options.length > 0
    ? createModelCapabilities({
        optionDescriptors: [
          buildSelectOptionDescriptor({
            id: "reasoningEffort",
            label: reasoning.name || "Thinking",
            options,
          }),
        ],
      })
    : EMPTY_CAPABILITIES;
}

export function buildKimiModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions.find(
    (option) => option.type === "select" && option.id === "model" && option.category === "model",
  );
  if (!modelOption || modelOption.type !== "select") return [];
  const capabilities = buildKimiCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  return kimiSessionSelectOptions(modelOption).flatMap((model) => {
    if (!model.value || seen.has(model.value)) return [];
    seen.add(model.value);
    return [
      {
        slug: model.value,
        name: model.name || model.value,
        isCustom: false,
        ...(model.value === modelOption.currentValue ? { isDefault: true } : {}),
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimiModelsFromSettings(kimiSettings.customModels);
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: kimiSettings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: kimiSettings.enabled
          ? "Checking Kimi Code CLI availability..."
          : "Kimi Code is disabled in T3 Code settings.",
      },
    });
  });
}

const runKimiCliCommand = (
  kimiSettings: KimiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const discoverKimiModelsViaAcp = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeKimiAcpRuntime({
      kimiSettings,
      environment,
      childProcessSpawner: spawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    const configOptions = yield* runtime.getConfigOptions;
    yield* runtime.request("session/delete", { sessionId: started.sessionId }).pipe(Effect.ignore);
    return buildKimiModelsFromConfigOptions(configOptions);
  }).pipe(Effect.scoped);

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);
  if (!kimiSettings.enabled) {
    return yield* buildInitialKimiProviderSnapshot(kimiSettings);
  }

  const versionResult = yield* runKimiCliCommand(kimiSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : "Failed to execute Kimi Code CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI timed out while running `kimi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but failed to run.",
      },
    });
  }

  // Runs alongside the ACP probe; the usage read only needs the on-disk
  // credential slot and the coding API, not a live ACP session.
  const usageProbe = probeKimiUsageLimits({ environment }).pipe(
    Effect.timeoutOption(USAGE_PROBE_TIMEOUT_MS),
  );

  const acpExit = yield* discoverKimiModelsViaAcp(kimiSettings, environment, cwd).pipe(
    Effect.timeoutOption(ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const discoveredModels = Exit.isSuccess(acpExit) ? Option.getOrElse(acpExit.value, () => []) : [];
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Kimi ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }
  const usageLimitsOption = yield* usageProbe;
  const usageLimits = Option.getOrElse(usageLimitsOption, () => undefined);
  const auth: ServerProviderAuth = acpFailed
    ? { status: "unknown" }
    : { status: "authenticated", type: "cached_token", label: "Kimi account" };

  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: true,
    checkedAt,
    models:
      discoveredModels.length > 0
        ? kimiModelsFromSettings(kimiSettings.customModels, discoveredModels)
        : fallbackModels,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: acpFailed ? "warning" : "ready",
      auth,
      ...(usageLimits ? { usageLimits } : {}),
      ...(acpFailed
        ? {
            message:
              "Kimi Code CLI is installed, but its ACP session could not be started. Run `kimi login` and check the server logs.",
          }
        : {}),
    },
  });
});
