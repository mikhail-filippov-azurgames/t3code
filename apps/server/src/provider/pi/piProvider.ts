import type {
  CustomModelSetting,
  ModelCapabilities,
  PiSettings,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, readCustomModelEntries } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Crypto from "effect/Crypto";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { normalizePiModelSlug, PI_BUNDLED_PROVIDER_ID } from "./piAgentDir.ts";
import { buildPiLaunchEnvironment, resolvePiLaunchProfile } from "./piPermissionBridge.ts";
import { parsePiListModelsOutput } from "./piRpcProtocol.ts";
import { PI_RUNTIME_PIN, resolvePiRuntime, type PiRuntimeLaunch } from "./piRuntime.ts";
import {
  parsePiLocalEndpoint,
  probePiInferenceEndpoint,
  sanitizePiBaseUrlForDisplay,
} from "./piInferenceServer.ts";

const PI_VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_PROVIDER_STATUS_AGENT_DIR = "provider-status";

const PI_PRESENTATION = {
  displayName: "Pi",
  supportsConversationRollback: false,
  badgeLabel: "Local",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
} as const;

const PI_EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

function qualifyPiCustomModels(
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<CustomModelSetting> {
  return customModels.map((model) =>
    typeof model === "string"
      ? (normalizePiModelSlug(model) ?? "")
      : { ...model, slug: normalizePiModelSlug(model.slug) ?? "" },
  );
}

function piModelEntry(
  slug: string,
  isDefault: boolean,
  customModel?: ReturnType<typeof readCustomModelEntries>[number],
): ServerProviderModel {
  const short = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  return {
    slug,
    name: customModel?.name ?? (short.length > 0 ? short : slug),
    isCustom: customModel !== undefined,
    ...(isDefault ? { isDefault: true } : {}),
    capabilities: customModel?.capabilities ?? PI_EMPTY_CAPABILITIES,
  };
}

export function piDiscoveredModelsToServerModels(
  slugs: ReadonlyArray<string>,
  input: {
    readonly configuredModel: string;
    readonly customModels: ReadonlyArray<CustomModelSetting>;
  },
): ReadonlyArray<ServerProviderModel> {
  const configuredModel = input.configuredModel.trim();
  const configuredSlug = normalizePiModelSlug(configuredModel);
  const customModels = qualifyPiCustomModels(input.customModels);
  const customModelsBySlug = new Map(
    readCustomModelEntries(customModels).map((model) => [model.slug, model]),
  );
  const ordered = [
    ...new Set([
      ...slugs.map((rawSlug) => {
        const slug = rawSlug.trim();
        return slug.includes("/") ? slug : (normalizePiModelSlug(slug) ?? "");
      }),
      ...(configuredSlug ? [configuredSlug] : []),
    ]),
  ].filter(Boolean);
  const defaultSlug = configuredSlug ?? ordered[0];
  const seen = new Set<string>();
  const builtIns: Array<ServerProviderModel> = [];
  ordered.forEach((slug) => {
    const normalized = slug.trim();
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    builtIns.push(
      piModelEntry(normalized, normalized === defaultSlug, customModelsBySlug.get(normalized)),
    );
  });
  return providerModelsFromSettings(builtIns, customModels, PI_EMPTY_CAPABILITIES);
}

export function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  configuredModel = "",
): ReadonlyArray<ServerProviderModel> {
  return piDiscoveredModelsToServerModels([], {
    configuredModel,
    customModels: customModels ?? [],
  });
}

export function piProviderProbeStatus(endpointProbe: {
  readonly ready: boolean;
}): "ready" | "warning" {
  return endpointProbe.ready ? "ready" : "warning";
}

const runPiCli = (
  launch: PiRuntimeLaunch,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  spawnAndCollect(
    launch.command,
    ChildProcess.make(launch.command, [...launch.prefixArgs, "--no-extensions", ...args], {
      cwd,
      env: environment,
      extendEnv: false,
    }),
  );

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels, piSettings.model);
    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        // The bundled CLI has not been launched yet. Keep Pi unselectable
        // until the status probe confirms that the runtime is present.
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking bundled Pi runtime...",
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  agentDir?: string | undefined,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels, piSettings.model);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  // A provider health check can run while a chat is using a model-specific
  // profile. Never rewrite the shared session agent dir with the provider's
  // default model/endpoint; keep the `--version` probe in its own FT3-owned
  // directory instead.
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const statusProbeAgentDir =
    agentDir === undefined ? undefined : path.join(agentDir, PI_PROVIDER_STATUS_AGENT_DIR);
  if (statusProbeAgentDir !== undefined) {
    yield* fileSystem.makeDirectory(statusProbeAgentDir, { recursive: true }).pipe(Effect.ignore);
  }
  const launchEnvironment = buildPiLaunchEnvironment(
    resolvePiLaunchProfile("approval-required"),
    environment,
    statusProbeAgentDir,
  );
  if (!launchEnvironment.ok) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: launchEnvironment.reason,
      },
    });
  }
  const probeEnv = launchEnvironment.environment;

  // This probe only checks the pinned executable version. Endpoint readiness
  // is checked separately below using the configured Pi settings.
  const runtimeResult = yield* resolvePiRuntime({
    binaryPath: piSettings.binaryPath,
    env: probeEnv,
  }).pipe(Effect.result);
  if (Result.isFailure(runtimeResult)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: runtimeResult.failure.message,
      },
    });
  }
  const runtime = runtimeResult.success;

  const versionResult = yield* runPiCli(runtime, ["--version"], probeEnv, cwd).pipe(
    Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionResult.failure)
          ? `Pi runtime (${runtime.origin}) failed to launch. Pin ${PI_RUNTIME_PIN}; see packaging/pi-runtime.json.`
          : "Failed to execute Pi health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi runtime (${runtime.origin}) timed out while running \`--version\`.`,
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi runtime (${runtime.origin}) is installed but failed to run. Check base URL ${sanitizePiBaseUrlForDisplay(piSettings.baseUrl)}.`,
      },
    });
  }

  const modelsResult = yield* runPiCli(runtime, ["--list-models"], probeEnv, cwd).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const listedByPi = modelsOutput
    ? parsePiListModelsOutput(`${modelsOutput.stdout}\n${modelsOutput.stderr}`)
    : [];
  const endpointModels = yield* Effect.promise(() => probePiInferenceEndpoint(piSettings));
  const discovered = [
    ...new Set([...listedByPi, ...(endpointModels.ready ? endpointModels.modelIds : [])]),
  ];
  const models = piDiscoveredModelsToServerModels(discovered, {
    configuredModel: piSettings.model,
    customModels: piSettings.customModels,
  });

  const baseUrl = sanitizePiBaseUrlForDisplay(piSettings.baseUrl);
  const isLoopback = parsePiLocalEndpoint(piSettings.baseUrl) !== undefined;
  return buildServerProvider({
    driver: "pi" as never,
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    skills: [],
    probe: {
      installed: true,
      version,
      status: piProviderProbeStatus(endpointModels),
      auth: isLoopback
        ? {
            status: "authenticated",
            type: "api_key",
            label: `Local endpoint ${PI_BUNDLED_PROVIDER_ID}`,
          }
        : piSettings.apiKey.trim().length > 0
          ? { status: "authenticated", type: "api_key", label: "Endpoint API key" }
          : { status: "unknown" },
      ...(!endpointModels.ready
        ? {
            message:
              listedByPi.length > 0
                ? `Pi ${version ?? PI_RUNTIME_PIN} (${runtime.origin}) lists ${listedByPi.length} model(s), but the endpoint is not ready: ${endpointModels.reason}`
                : `Pi ${version ?? PI_RUNTIME_PIN} (${runtime.origin}) is installed; the endpoint is not ready: ${endpointModels.reason} Point base URL at an OpenAI-compatible server (current: ${baseUrl}).`,
          }
        : {}),
    },
  });
});
