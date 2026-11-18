import {
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import type { ZavodConnectResult, ZavodStatus } from "../rpc-contracts.ts";
import { detectZavod, resolvePersonalHome, type ZavodDetection } from "./detect.ts";
import * as Instances from "./instances.ts";
import {
  copyPersonalSettings,
  ZavodPersonalCopyError,
  type PersonalCopyReport,
  type PersonalFamily,
  type PersonalCopySource,
} from "./personalCopy.ts";

export class ZavodService extends Context.Service<
  ZavodService,
  {
    readonly detect: () => Effect.Effect<ZavodStatus, ServerSettingsError>;
    readonly connect: () => Effect.Effect<
      ZavodConnectResult,
      ServerSettingsError | Instances.ZavodInstancesError
    >;
    readonly copyPersonal: (input: {
      readonly dryRun: boolean;
    }) => Effect.Effect<PersonalCopyReport, ServerSettingsError | ZavodPersonalCopyError>;
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

export const toZavodStatus = ({
  state,
  baseUrl,
  baseUrlSource,
  reason,
}: ZavodDetection): ZavodStatus => ({
  state,
  baseUrl,
  baseUrlSource: baseUrlSource === null ? null : baseUrlSource === "state" ? "state" : "default",
  ...(baseUrlSource === null ? {} : { baseUrlOrigin: baseUrlSource }),
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
  const zavodRoot = path.join((yield* ServerConfig.ServerConfig).stateDir, "zavod");

  const personalContext = Effect.fn("ZavodService.personalContext")(function* () {
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
    return { current, claude, codex, claudeEnvironment, codexEnvironment };
  });
  type PersonalContext = Effect.Success<ReturnType<typeof personalContext>>;

  const detectWith = Effect.fn("ZavodService.detection")(function* ({
    claude,
    codex,
    claudeEnvironment,
    codexEnvironment,
  }: PersonalContext) {
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
  const detection = () => personalContext().pipe(Effect.flatMap(detectWith));

  const copyFamilies = Effect.fn("ZavodService.copyFamilies")(function* (input: {
    readonly dryRun: boolean;
    readonly only?: ReadonlySet<PersonalFamily>;
  }) {
    const context = yield* personalContext();
    const detected = yield* detectWith(context);
    if (
      detected.state === "unsupported" ||
      detected.state === "absent" ||
      detected.baseUrl === null ||
      detected.helperPath === null
    ) {
      return yield* new ZavodPersonalCopyError({ stage: "state" });
    }
    const windows = platform === "win32";
    const same = (left: string, right: string) =>
      windows ? left.toLowerCase() === right.toLowerCase() : left === right;
    const claudeHome = resolvePersonalHome(
      {
        configured: configuredHome(context.claude?.config),
        environment: context.claudeEnvironment.CLAUDE_CONFIG_DIR,
        defaultName: ".claude",
        home: homeDirectory,
      },
      path,
    );
    const codexHome = resolvePersonalHome(
      {
        configured: configuredHome(context.codex?.config),
        environment: context.codexEnvironment.CODEX_HOME,
        defaultName: ".codex",
        home: homeDirectory,
      },
      path,
    );
    // Claude Code keeps user-scope MCP servers in ~/.claude.json, or inside a custom config dir.
    const claudeJson = same(claudeHome, path.resolve(homeDirectory, ".claude"))
      ? path.join(homeDirectory, ".claude.json")
      : path.join(claudeHome, ".claude.json");
    const families: Array<PersonalCopySource> = [];
    for (const [family, id, sourceHome] of [
      ["claude", "zavod-claude", claudeHome],
      ["codex", "zavod-codex", codexHome],
    ] as const) {
      const instance = context.current.providerInstances[ProviderInstanceId.make(id)];
      if (instance === undefined || input.only?.has(family) === false) continue;
      const targetHome = path.join(zavodRoot, id);
      if (configuredHome(instance.config) !== targetHome) {
        return yield* new ZavodPersonalCopyError({ stage: "state" });
      }
      families.push({
        family,
        sourceHome,
        targetHome,
        ...(family === "claude" ? { claudeJson } : {}),
      });
    }
    if (families.length === 0) return yield* new ZavodPersonalCopyError({ stage: "state" });
    return yield* copyPersonalSettings({
      families,
      baseUrl: detected.baseUrl,
      helperPath: detected.helperPath,
      dryRun: input.dryRun,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });
  const copyLocked = (input: {
    readonly dryRun: boolean;
    readonly only?: ReadonlySet<PersonalFamily>;
  }) => copyFamilies(input).pipe(Instances.connectSemaphore.withPermits(1));

  return ZavodService.of({
    copyPersonal: Effect.fn("ZavodService.copyPersonal")(
      ({ dryRun }: { readonly dryRun: boolean }) => copyLocked({ dryRun }),
    ),
    detect: Effect.fn("ZavodService.detect")(function* () {
      return toZavodStatus(yield* detection());
    }),
    connect: Effect.fn("ZavodService.connect")(function* () {
      const context = yield* personalContext();
      const detected = yield* detectWith(context);
      // Only a family whose instance is created now gets the first copy; reconnect never copies.
      const created = new Set<PersonalFamily>(
        (["claude", "codex"] as const).filter(
          (family) =>
            context.current.providerInstances[ProviderInstanceId.make(`zavod-${family}`)] ===
            undefined,
        ),
      );
      const connected = yield* instances.connect(detected);
      const status = { ...toZavodStatus(detected), ...connected };
      if (created.size === 0) return status;
      // The connection is already committed, so a failed copy only changes the reported outcome.
      const copy = yield* Effect.exit(copyLocked({ dryRun: false, only: created }));
      return {
        ...status,
        personalCopy: Exit.isSuccess(copy) ? ("copied" as const) : ("failed" as const),
      };
    }),
  });
});

export const layer = Layer.effect(ZavodService, make);
