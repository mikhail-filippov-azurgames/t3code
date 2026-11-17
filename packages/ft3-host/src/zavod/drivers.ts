import type { ResolvedProviderInstanceEnvironment, ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ClaudeDriver } from "../../../../apps/server/src/provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../../../../apps/server/src/provider/Drivers/CodexDriver.ts";
import { expandHome } from "./detect.ts";
import {
  applyGatewayModels,
  fetchGatewayModels,
  filterModelFamily,
  listMatchesCatalog,
  readZavodGatewayConfig,
  type GatewayCatalogModel,
  type GatewayModelsList,
  type GatewayModelsResult,
  type ModelFamily,
} from "./gatewayModels.ts";

interface GatewayState {
  readonly latest: GatewayModelsResult;
  readonly lastGood: GatewayModelsList | undefined;
}

/**
 * Narrows the snapshot's models to the instance family and the gateway list.
 * Only `refresh` and the first check call `load`; reads and the change stream use the cached result.
 */
export const makeGatewayModelsInstance = Effect.fn("Zavod.makeGatewayModelsInstance")(function* <
  I extends ProviderInstance,
>(instance: I, family: ModelFamily, load: Effect.Effect<GatewayModelsResult>) {
  const upstream = instance.snapshot;
  const state = yield* Ref.make<GatewayState>({
    latest: { kind: "unavailable", reason: "not checked" },
    lastGood: undefined,
  });
  const checked = yield* PubSub.unbounded<void>();
  const narrow = <M extends GatewayCatalogModel>(models: ReadonlyArray<M>, current: GatewayState) =>
    applyGatewayModels(filterModelFamily(models, family), current.latest, current.lastGood);
  const view = (snapshot: ServerProvider) =>
    Effect.map(Ref.get(state), (current) => ({
      ...snapshot,
      models: narrow(snapshot.models, current),
    }));
  // A list that matches nothing in the family catalog must not displace a usable last good list.
  const check = Effect.flatMap(load, (result) =>
    Effect.flatMap(upstream.getSnapshot, (current) => {
      const usable =
        result.kind === "list" &&
        listMatchesCatalog(filterModelFamily(current.models, family), result);
      return Ref.update(state, (previous) => ({
        latest: result,
        lastGood: usable ? result : previous.lastGood,
      }));
    }),
  );
  yield* check.pipe(Effect.andThen(PubSub.publish(checked, undefined)), Effect.forkScoped);

  const snapshot: ManagedServerProvider = {
    ...upstream,
    getSnapshot: Effect.flatMap(upstream.getSnapshot, view),
    refresh: Effect.all([check, upstream.refresh], { concurrency: 2 }).pipe(
      Effect.flatMap(([, refreshed]) => view(refreshed)),
    ),
    streamChanges: Stream.merge(
      upstream.streamChanges,
      Stream.fromPubSub(checked).pipe(Stream.mapEffect(() => upstream.getSnapshot)),
    ).pipe(Stream.mapEffect(view)),
  };
  const snapshotForCwd = instance.snapshotForCwd;
  return {
    ...instance,
    snapshot,
    ...(snapshotForCwd === undefined
      ? {}
      : {
          snapshotForCwd: (cwd: string) =>
            Effect.flatMap(snapshotForCwd(cwd), (scoped) =>
              Effect.map(Ref.get(state), (current) => ({
                ...scoped,
                models: narrow(scoped.models, current),
                ...(scoped.workspaceModels === undefined
                  ? {}
                  : { workspaceModels: narrow(scoped.workspaceModels, current) }),
              })),
            ),
        }),
  } satisfies ProviderInstance as I;
});

/** Returns the instance unchanged unless its home routes through a gateway with a key helper. */
export const withZavodGatewayModels = Effect.fn("Zavod.withGatewayModels")(function* <
  I extends ProviderInstance,
>(
  instance: I,
  input: {
    readonly family: ModelFamily;
    readonly homePath: string;
    readonly homeDirectory?: string;
  },
): Effect.fn.Return<
  I,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
> {
  const config = yield* readZavodGatewayConfig(input);
  if (config === null) return instance;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const load = fetchGatewayModels(config).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return yield* makeGatewayModelsInstance(instance, input.family, load);
});

const resolveHome = Effect.fn("Zavod.resolveInstanceHome")(function* (input: {
  readonly configured: string;
  readonly variable: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  readonly fallback: ".claude" | ".codex";
  readonly environment: ResolvedProviderInstanceEnvironment;
}) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const host = yield* HostProcess.Environment;
  const raw =
    input.configured.trim() ||
    input.environment.find((entry) => entry.name === input.variable)?.value.trim() ||
    host[input.variable]?.trim() ||
    path.join(home, input.fallback);
  return path.resolve(expandHome(raw, home, path));
});

export const Ft3ClaudeDriver: typeof ClaudeDriver = {
  ...ClaudeDriver,
  create: Effect.fn("Ft3ClaudeDriver.create")(function* (input) {
    const instance = yield* ClaudeDriver.create(input);
    const homePath = yield* resolveHome({
      configured: input.config.homePath,
      variable: "CLAUDE_CONFIG_DIR",
      fallback: ".claude",
      environment: input.environment,
    });
    return yield* withZavodGatewayModels(instance, { family: "claude", homePath });
  }),
};

export const Ft3CodexDriver: typeof CodexDriver = {
  ...CodexDriver,
  create: Effect.fn("Ft3CodexDriver.create")(function* (input) {
    const instance = yield* CodexDriver.create(input);
    const homePath = yield* resolveHome({
      configured: input.config.homePath,
      variable: "CODEX_HOME",
      fallback: ".codex",
      environment: input.environment,
    });
    return yield* withZavodGatewayModels(instance, { family: "codex", homePath });
  }),
};
