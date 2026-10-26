import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { probeKimiUsageLimits } from "./usageLimits.ts";

/** The ACP probe already refreshes on its own schedule; limits only need to stay recent. */
const USAGE_CACHE_TTL_MS = 60_000;
const KIMI_AGENT_ID = "kimi";
const KIMI_EXECUTABLE = "kimi";

export type Ft3KimiDriverEnv = AcpRegistryDriverEnv | HttpClient.HttpClient;

function executableStem(commandPath: string): string {
  const normalized = commandPath.trim().replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

/** Limits are Kimi-specific: only a Kimi ACP instance may publish them. */
export function isKimiAcpSettings(config: AcpRegistrySettings): boolean {
  if (config.source === "registry") {
    return config.agentId.trim().toLowerCase() === KIMI_AGENT_ID;
  }
  return executableStem(config.commandPath) === KIMI_EXECUTABLE;
}

interface CachedLimits {
  readonly at: number;
  readonly limits: ServerProviderUsageLimits;
}

const withLimits = (
  snapshot: ServerProvider,
  usageLimits: ServerProviderUsageLimits,
): ServerProvider => ({ ...snapshot, usageLimits });

/** ACP snapshots have no usage surface; read limits beside them and cache briefly. */
export const withKimiUsageLimits = Effect.fn("Ft3KimiDriver.withUsageLimits")(function* (input: {
  readonly snapshot: ManagedServerProvider;
  readonly probe: Effect.Effect<ServerProviderUsageLimits>;
}): Effect.fn.Return<ManagedServerProvider> {
  const cache = yield* Ref.make<CachedLimits | null>(null);
  const semaphore = yield* Semaphore.make(1);

  const readLimits = Effect.fnUntraced(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (!force && cached !== null && now - cached.at < USAGE_CACHE_TTL_MS) {
      return cached.limits;
    }
    const limits = yield* input.probe;
    yield* Ref.set(cache, { at: now, limits });
    return limits;
  });

  const decorate = (current: ServerProvider, force: boolean) =>
    current.enabled
      ? semaphore
          .withPermit(readLimits(force))
          .pipe(Effect.map((limits) => withLimits(current, limits)))
      : Effect.succeed(current);

  return {
    resolveMaintenance: input.snapshot.resolveMaintenance,
    applyUsageLimits: input.snapshot.applyUsageLimits,
    getSnapshot: input.snapshot.getSnapshot.pipe(
      Effect.flatMap((current) => decorate(current, false)),
    ),
    refresh: input.snapshot.refresh.pipe(Effect.flatMap((current) => decorate(current, true))),
    streamChanges: input.snapshot.streamChanges.pipe(
      Stream.mapEffect((current) => decorate(current, false)),
    ),
  };
});

export const Ft3KimiDriver: ProviderDriver<AcpRegistrySettings, Ft3KimiDriverEnv> = {
  ...AcpRegistryDriver,
  create: Effect.fn("Ft3KimiDriver.create")(function* (input) {
    const instance = yield* AcpRegistryDriver.create(input);
    if (!isKimiAcpSettings(input.config)) {
      return instance;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const hostEnvironment = yield* HostProcess.Environment;
    const environment = yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment);

    const probe = probeKimiUsageLimits({ environment }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const snapshot = yield* withKimiUsageLimits({ snapshot: instance.snapshot, probe });

    return { ...instance, snapshot };
  }),
};
