/**
 * MuseCodeProvider — snapshot and health probe for the Muse Code driver.
 *
 * The version probe proves the native binary runs; the catalog probe spawns
 * one scoped `muse serve` host and reads `model/list`. A successful catalog
 * probe means the host used its persisted account login: the driver strips
 * API keys before this point, so no key could have authorized it.
 *
 * @module provider/muse/MuseCodeProvider
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type MuseCodeSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  listMuseModels,
  readMuseVersionPin,
  resolveMuseServeBinary,
  spawnMuseHost,
  stripMuseApiKeys,
  type MuseModelRow,
} from "./MuseMspRuntime.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  supportsConversationRollback: false,
  badgeLabel: "Subscription",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const CATALOG_PROBE_TIMEOUT_MS = 20_000;

export function museModelsFromRows(rows: ReadonlyArray<MuseModelRow>): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const row of rows) {
    if (seen.has(row.modelId)) {
      continue;
    }
    seen.add(row.modelId);
    models.push({
      slug: row.modelId,
      name: row.displayLabel || row.modelId,
      isCustom: false,
      ...(row.isDefault ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

function museModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialMuseCodeProviderSnapshot(
  museSettings: MuseCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = museModelsFromSettings(museSettings.customModels);

    if (!museSettings.enabled) {
      return buildServerProvider({
        presentation: MUSE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Muse Code is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Muse CLI availability...",
      },
    });
  });
}

const runMuseCliCommand = (
  museBin: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(museBin, args, { env: environment });
    return yield* spawnAndCollect(
      museBin,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface MuseProbeInput {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

function museHostEnvironment(environment: NodeJS.ProcessEnv): {
  readonly env: NodeJS.ProcessEnv;
  readonly hadApiKey: boolean;
} {
  const { env, stripped } = stripMuseApiKeys(environment);
  return { env, hadApiKey: stripped.length > 0 };
}

export const checkMuseCodeProviderStatus = Effect.fn("checkMuseCodeProviderStatus")(function* (
  museSettings: MuseCodeSettings,
  probeInput: MuseProbeInput,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = museModelsFromSettings(museSettings.customModels);

  if (!museSettings.enabled) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse Code is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runMuseCliCommand(probeInput.binaryPath, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Muse CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Muse CLI is not installed or not on PATH."
          : "Failed to execute Muse CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse CLI is installed but timed out while running `muse --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Muse CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse CLI is installed but failed to run.",
      },
    });
  }

  const hostEnv = museHostEnvironment(probeInput.environment);
  const catalogExit = yield* Effect.gen(function* () {
    const pin = yield* readMuseVersionPin({ binaryPath: probeInput.binaryPath });
    const museBin = yield* resolveMuseServeBinary({
      binaryPath: probeInput.binaryPath,
      platform: process.platform,
      ...(pin === undefined ? {} : { pinnedVersion: pin }),
    });
    const host = yield* spawnMuseHost({ museBin, env: hostEnv.env });
    yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));
    return yield* listMuseModels(host);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(CATALOG_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const catalogRows = Exit.isSuccess(catalogExit) ? Option.getOrElse(catalogExit.value, () => []) : [];
  const catalogFailed = Exit.isFailure(catalogExit) || Option.isNone(catalogExit.value);
  if (catalogFailed) {
    yield* Effect.logWarning("Muse MSP catalog probe failed or timed out.", {
      errorTag: Exit.isFailure(catalogExit) ? causeErrorTag(catalogExit.cause) : "Timeout",
    });
  }

  const discoveredModels = museModelsFromRows(catalogRows);
  const models =
    discoveredModels.length > 0
      ? providerModelsFromSettings(discoveredModels, museSettings.customModels ?? [], EMPTY_CAPABILITIES)
      : fallbackModels;

  if (hostEnv.hadApiKey) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse instance environment carries an API key; subscription provenance is unclear.",
      },
    });
  }

  if (catalogFailed) {
    const auth: ServerProviderAuth = { status: "unknown" };
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Muse CLI is installed but the subscription host did not answer. Run `muse login`.",
      },
    });
  }

  const auth: ServerProviderAuth = {
    status: "authenticated",
    type: "cached_token",
    label: "Muse Code subscription",
  };
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: museSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});
