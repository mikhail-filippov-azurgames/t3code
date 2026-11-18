// @effect-diagnostics nodeBuiltinImport:off - Rollback needs atomic empty-only rmdir, absent from FileSystem.
import * as NodeFSP from "node:fs/promises";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parse, stringify } from "smol-toml";

import * as ServerConfig from "../../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import type { ZavodDetection } from "./detect.ts";

export class ZavodInstancesError extends Schema.TaggedError<
  ZavodInstancesError,
  { readonly brand: unique symbol }
>()("ZavodInstancesError", {
  stage: Schema.Literals(["state", "conflict", "configuration", "write", "rollback"]),
  instanceId: Schema.optionalKey(ProviderInstanceId),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    const instance = this.instanceId === undefined ? "" : ` for ${this.instanceId}`;
    return `Zavod connection ${this.stage} failed${instance}.`;
  }
}

interface ConnectedInstances {
  readonly claudeInstanceId: ProviderInstanceId;
  readonly codexInstanceId: ProviderInstanceId;
}

export class ZavodInstances extends Context.Service<
  ZavodInstances,
  {
    readonly connect: (
      detection: ZavodDetection,
    ) => Effect.Effect<ConnectedInstances, ZavodInstancesError>;
  }
>()("@t3tools/ft3-host/zavod/instances/ZavodInstances") {}

const isZavodInstancesError = Schema.is(ZavodInstancesError);
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeClaude = Schema.decodeUnknownSync(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeHome = Schema.decodeUnknownOption(Schema.Struct({ homePath: Schema.String }));
const managedIds = {
  claudeInstanceId: ProviderInstanceId.make("zavod-claude"),
  codexInstanceId: ProviderInstanceId.make("zavod-codex"),
};

// RPC layers are built per connection, so all layer instances share this process-wide lock.
const connectSemaphore = Semaphore.makeUnsafe(1);

export function configContents(
  text: string | undefined,
  claude: boolean,
  baseUrl: string,
  helperPath: string,
  windows: boolean,
): string {
  if (claude) {
    const settings = text === undefined ? {} : decodeClaude(text);
    return `${JSON.stringify(
      {
        ...settings,
        env: { ...decodeObject(settings.env ?? {}), ANTHROPIC_BASE_URL: new URL(baseUrl).origin },
        apiKeyHelper: JSON.stringify(windows ? helperPath.replaceAll("\\", "/") : helperPath),
      },
      null,
      2,
    )}\n`;
  }
  const settings = text === undefined ? {} : parse(text);
  const providers = decodeObject(settings.model_providers ?? {});
  const provider = decodeObject(providers.zavod ?? {});
  return stringify({
    ...settings,
    model_provider: "zavod",
    model_providers: {
      ...providers,
      zavod: {
        ...provider,
        name: "Zavod",
        base_url: baseUrl,
        wire_api: "responses",
        auth: {
          ...decodeObject(provider.auth ?? {}),
          command: helperPath,
          refresh_interval_ms: 300000,
        },
        http_headers: {
          ...decodeObject(provider.http_headers ?? {}),
          "x-openai-actor-authorization": "zavod",
        },
      },
    },
  });
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const root = path.join(config.stateDir, "zavod");
  const write = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const read = Effect.fn("ZavodInstances.read")(function* (file: string) {
    return yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
  });
  const inspect = Effect.fn("ZavodInstances.inspect")(function* (file: string) {
    return yield* fs.lstat(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
  });

  const connect = Effect.fn("ZavodInstances.connect")(function* (detection: ZavodDetection) {
    if (
      detection.state === "unsupported" ||
      detection.state === "absent" ||
      detection.baseUrl === null ||
      detection.helperPath === null
    ) {
      return yield* new ZavodInstancesError({ stage: "state" });
    }
    const baseUrl = detection.baseUrl;
    const helperPath = detection.helperPath;
    if (!path.isAbsolute(helperPath) || /[\x00-\x1f\x7f$`;&|<>(){}%!^*?[\]"']/.test(helperPath)) {
      return yield* new ZavodInstancesError({ stage: "configuration" });
    }
    const snapshot = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new ZavodInstancesError({ stage: "write", cause })),
    );
    const candidates = [
      {
        id: managedIds.claudeInstanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude (Zavod)",
        file: "settings.json",
        claude: true,
      },
      {
        id: managedIds.codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex (Zavod)",
        file: "config.toml",
        claude: false,
      },
    ].map((candidate) => ({
      ...candidate,
      home: path.join(root, candidate.id),
      previous: snapshot.providerInstances[candidate.id],
    }));
    for (const candidate of candidates) {
      if (candidate.previous === undefined) continue;
      const home = decodeHome(candidate.previous.config);
      if (
        candidate.previous.driver !== candidate.driver ||
        home._tag === "None" ||
        home.value.homePath !== candidate.home
      ) {
        return yield* new ZavodInstancesError({ stage: "conflict", instanceId: candidate.id });
      }
    }

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const undo: Array<Effect.Effect<void, ZavodInstancesError>> = [];
        const retained = new Set<ProviderInstanceId>();
        const createDirectory = Effect.fn("ZavodInstances.createDirectory")(function* (
          directory: string,
          id?: ProviderInstanceId,
        ) {
          const info = yield* inspect(directory);
          if (info !== undefined) {
            if (info.type !== "Directory")
              return yield* new ZavodInstancesError({
                stage: "conflict",
                ...(id === undefined ? {} : { instanceId: id }),
              });
            return;
          }
          yield* fs.makeDirectory(directory);
          undo.push(
            Effect.suspend(() =>
              (id === undefined ? retained.size > 0 : retained.has(id))
                ? Effect.void
                : Effect.tryPromise({
                    try: () => NodeFSP.rmdir(directory),
                    catch: (cause) =>
                      new ZavodInstancesError({
                        stage: "rollback",
                        ...(id === undefined ? {} : { instanceId: id }),
                        cause,
                      }),
                  }),
            ),
          );
        });
        const mutation = Effect.gen(function* () {
          yield* createDirectory(root);
          for (const candidate of candidates) {
            yield* createDirectory(candidate.home, candidate.id);
            const file = path.join(candidate.home, candidate.file);
            const info = yield* inspect(file);
            if (info !== undefined && info.type !== "File") {
              return yield* new ZavodInstancesError({
                stage: "conflict",
                instanceId: candidate.id,
              });
            }
            const before = yield* read(file);
            const after = yield* Effect.try({
              try: () =>
                configContents(before, candidate.claude, baseUrl, helperPath, path.sep === "\\"),
              catch: (cause) =>
                new ZavodInstancesError({
                  stage: "configuration",
                  instanceId: candidate.id,
                  cause,
                }),
            });
            if (before !== after) {
              undo.push(
                Effect.gen(function* () {
                  if (retained.has(candidate.id)) return;
                  const current = yield* read(file);
                  if (current === before) return;
                  if (current !== after)
                    return yield* new ZavodInstancesError({
                      stage: "rollback",
                      instanceId: candidate.id,
                    });
                  yield* before === undefined ? fs.remove(file) : write(file, before);
                }).pipe(
                  Effect.mapError((cause) =>
                    isZavodInstancesError(cause)
                      ? cause
                      : new ZavodInstancesError({
                          stage: "rollback",
                          instanceId: candidate.id,
                          cause,
                        }),
                  ),
                ),
              );
              yield* write(file, after);
            }
            if (candidate.previous !== undefined) continue;
            const instance: ProviderInstanceConfig = {
              driver: candidate.driver,
              displayName: candidate.displayName,
              enabled: true,
              config: { homePath: candidate.home },
            };
            const saved = yield* settings.updateProviderInstance({
              operation: "create",
              instanceId: candidate.id,
              instance,
            });
            const created = saved.providerInstances[candidate.id];
            undo.push(
              Effect.gen(function* () {
                const current = (yield* settings.getSettings).providerInstances[candidate.id];
                if (current === undefined) return;
                if (!Equal.equals(current, created)) {
                  retained.add(candidate.id);
                  return yield* new ZavodInstancesError({
                    stage: "rollback",
                    instanceId: candidate.id,
                  });
                }
                // The settings API has no compare-and-delete, leaving a race after this check.
                yield* settings.updateProviderInstance({
                  operation: "remove",
                  instanceId: candidate.id,
                });
              }).pipe(
                Effect.mapError((cause) => {
                  retained.add(candidate.id);
                  return isZavodInstancesError(cause)
                    ? cause
                    : new ZavodInstancesError({
                        stage: "rollback",
                        instanceId: candidate.id,
                        cause,
                      });
                }),
              ),
            );
          }
          return managedIds;
        });
        const outcome = yield* Effect.exit(mutation);
        if (Exit.isSuccess(outcome)) return outcome.value;
        let rollbackError: ZavodInstancesError | undefined;
        for (const action of undo.toReversed()) {
          const result = yield* Effect.result(action);
          if (result._tag === "Failure") rollbackError ??= result.failure;
        }
        if (rollbackError !== undefined) return yield* rollbackError;
        return yield* Effect.failCause(outcome.cause);
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isZavodInstancesError(cause) ? cause : new ZavodInstancesError({ stage: "write", cause }),
      ),
    );
  }, connectSemaphore.withPermits(1));

  return ZavodInstances.of({ connect });
});

export const layer = Layer.effect(ZavodInstances, make);
