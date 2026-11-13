import {
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import type { ZavodConnectResult, ZavodStatus } from "../rpc-contracts.ts";
import { detectZavod, type ZavodDetection } from "./detect.ts";
import * as Instances from "./instances.ts";

export class ZavodService extends Context.Service<
  ZavodService,
  {
    readonly detect: () => Effect.Effect<ZavodStatus, ServerSettingsError>;
    readonly connect: () => Effect.Effect<
      ZavodConnectResult,
      ServerSettingsError | Instances.ZavodInstancesError
    >;
  }
>()("@t3tools/ft3-host/zavod/service/ZavodService") {}

const decodeHome = Schema.decodeUnknownOption(Schema.Struct({ homePath: Schema.String }));
const configuredHome = (config: unknown) =>
  Option.getOrUndefined(decodeHome(config))?.homePath ?? "";

function hasSecretOverride(environment: ProviderInstanceEnvironment | undefined, windows: boolean) {
  return (
    environment?.some((variable) => {
      const name = windows ? variable.name.toUpperCase() : variable.name;
      return (
        ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"].includes(
          name,
        ) &&
        (typeof variable.value !== "string" || variable.sensitive || variable.valueRedacted)
      );
    }) ?? false
  );
}

const status = ({ state, baseUrl, baseUrlSource, reason }: ZavodDetection): ZavodStatus => ({
  state,
  baseUrl,
  baseUrlSource,
  reason,
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* Instances.ZavodInstances;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;

  const detection = Effect.fn("ZavodService.detection")(function* () {
    const current = yield* settings.getSettings;
    const claude = current.providerInstances[ProviderInstanceId.make("claudeAgent")];
    const codex = current.providerInstances[ProviderInstanceId.make("codex")];
    const merge = (variables: ProviderInstanceEnvironment | undefined) =>
      mergeProviderInstanceEnvironment(
        variables?.filter((variable) => !variable.sensitive),
        environment,
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        Effect.provideService(HostProcess.Platform, platform),
      );
    const claudeEnvironment = yield* merge(claude?.environment);
    const codexEnvironment = yield* merge(codex?.environment);
    const detected = yield* detectZavod({
      claudeHomePath: configuredHome(claude?.config),
      codexHomePath: configuredHome(codex?.config),
      homeDirectory,
      environment,
      claudeEnvironment,
      codexEnvironment,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );
    if (
      detected.state !== "absent" &&
      (hasSecretOverride(claude?.environment, platform === "win32") ||
        hasSecretOverride(codex?.environment, platform === "win32"))
    ) {
      return {
        ...detected,
        state: "unsupported" as const,
        reason: "Provider environment overrides require a secret value.",
      };
    }
    return detected;
  });

  return ZavodService.of({
    detect: Effect.fn("ZavodService.detect")(function* () {
      return status(yield* detection());
    }),
    connect: Effect.fn("ZavodService.connect")(function* () {
      const detected = yield* detection();
      const connected = yield* instances.connect(detected);
      return { ...status(detected), ...connected };
    }),
  });
});

export const layer = Layer.effect(ZavodService, make);
