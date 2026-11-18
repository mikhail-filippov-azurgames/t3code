import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { parse } from "smol-toml";

import * as ServerConfig from "../../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import * as ServerSecretStore from "../../../../apps/server/src/auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../../../../apps/server/src/persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../../apps/server/src/policy/ManagedPolicy.ts";
import type { ZavodDetection } from "./detect.ts";
import * as Instances from "./instances.ts";

const claudeId = ProviderInstanceId.make("zavod-claude");
const codexId = ProviderInstanceId.make("zavod-codex");
const manualId = ProviderInstanceId.make("claudeZavod");
const sentinel = "fixture-zavod-key-never-read-by-corvis";
const manualInstance = {
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "My gateway",
  config: { homePath: "custom-home" },
};

const testLayer = ServerSettings.layerTest({
  providerInstances: {
    [manualId]: manualInstance,
    [ProviderInstanceId.make("codexZavod")]: {
      ...manualInstance,
      driver: ProviderDriverKind.make("codex"),
    },
  },
}).pipe(
  Layer.provideMerge(ServerConfig.layerTest(".", { prefix: "t3-zavod-instances-" })),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

const persistedTestLayer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(".", { prefix: "t3-zavod-persisted-" })),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)),
);

const fixture = Effect.fn("test.zavodInstancesFixture")(function* (
  options: {
    readonly beforeMutation?: (
      mutation: ProviderInstanceMutation,
      settings: ServerSettings.ServerSettingsService["Service"],
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly fileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const root = path.join(config.stateDir, "zavod");
  yield* fs.makeDirectory(config.secretsDir, { recursive: true });
  const helperPath = path.join(config.baseDir, "Zavod Tools", "zavod-key");
  yield* fs.makeDirectory(path.dirname(helperPath));
  yield* fs.writeFileString(helperPath, sentinel);
  const detection: ZavodDetection = {
    state: "off",
    baseUrl: "https://zavod.example/v1",
    baseUrlSource: "state",
    helperPath,
    reason: null,
  };
  const writes: ProviderInstanceMutation[] = [];
  const wrapped = ServerSettings.ServerSettingsService.of({
    ...settings,
    updateProviderInstance: (mutation, patch) =>
      Effect.gen(function* () {
        writes.push(mutation);
        yield* options.beforeMutation?.(mutation, settings) ?? Effect.void;
        return yield* settings.updateProviderInstance(mutation, patch);
      }),
  });
  const secretCalls: string[] = [];
  const denied = (name: string) =>
    Effect.sync(() => {
      secretCalls.push(name);
    }).pipe(Effect.andThen(Effect.die("Zavod accessed the secret store")));
  const context = yield* Layer.build(Instances.layer).pipe(
    Effect.provideService(ServerSettings.ServerSettingsService, wrapped),
    Effect.provideService(FileSystem.FileSystem, options.fileSystem?.(fs) ?? fs),
    Effect.provideService(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: denied,
        set: denied,
        create: denied,
        remove: denied,
        getOrCreateRandom: denied,
      }),
    ),
  );
  return {
    service: Context.get(context, Instances.ZavodInstances),
    settings,
    wrapped,
    fs,
    path,
    config,
    root,
    detection,
    writes,
    secretCalls,
  };
});

const failure = () =>
  new ServerSettingsError({ settingsPath: "fixture", operation: "create-provider-instance" });

describe("ZavodInstances", () => {
  it.effect("blocked states leave settings and disk untouched", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.settings.getSettings;
      for (const detection of [
        { ...f.detection, state: "unsupported" },
        { ...f.detection, state: "absent" },
        { ...f.detection, state: "unsupported", baseUrl: null, baseUrlSource: null },
        { ...f.detection, state: "off", baseUrl: null, baseUrlSource: null },
      ] satisfies ReadonlyArray<ZavodDetection>) {
        const error = yield* f.service.connect(detection).pipe(Effect.flip);
        assert.equal(error.stage, "state");
      }
      assert.deepEqual(yield* f.settings.getSettings, before);
      assert.deepEqual(f.writes, []);
      assert.isFalse(yield* f.fs.exists(f.root));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("creates the two stable instances and helper configs without obtaining a key", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.settings.getSettings;
      const connected = yield* f.service.connect({ ...f.detection, state: "on" });
      assert.deepEqual(connected, {
        claudeInstanceId: claudeId,
        codexInstanceId: codexId,
        created: ["claude", "codex"],
      });
      const settings = yield* f.settings.getSettings;
      assert.equal(settings.providerInstances[claudeId]?.displayName, "Claude (Zavod)");
      assert.equal(settings.providerInstances[codexId]?.displayName, "Codex (Zavod)");
      for (const [id, previous] of Object.entries(before.providerInstances))
        assert.deepEqual(settings.providerInstances[ProviderInstanceId.make(id)], previous);
      const claudeText = yield* f.fs.readFileString(f.path.join(f.root, claudeId, "settings.json"));
      const claude = JSON.parse(claudeText);
      assert.equal(claude.env.ANTHROPIC_BASE_URL, "https://zavod.example");
      assert.equal(
        claude.apiKeyHelper,
        JSON.stringify(f.detection.helperPath?.replaceAll("\\", "/")),
      );
      const codexText = yield* f.fs.readFileString(f.path.join(f.root, codexId, "config.toml"));
      assert.deepEqual(parse(codexText), {
        model_provider: "zavod",
        model_providers: {
          zavod: {
            name: "Zavod",
            base_url: "https://zavod.example/v1",
            wire_api: "responses",
            auth: { command: f.detection.helperPath!, refresh_interval_ms: 300000 },
            http_headers: { "x-openai-actor-authorization": "zavod" },
          },
        },
      });
      assert.deepEqual(
        f.writes.map((write) => write.operation),
        ["create", "create"],
      );
      assert.deepEqual(f.secretCalls, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "keeps helper output out of persisted settings, managed homes and the real secret store",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.service.connect(f.detection);
        for (const file of [
          f.config.settingsPath,
          f.path.join(f.root, claudeId, "settings.json"),
          f.path.join(f.root, codexId, "config.toml"),
        ]) {
          assert.notInclude(yield* f.fs.readFileString(file), sentinel);
        }
        assert.deepEqual(yield* f.fs.readDirectory(f.config.secretsDir), []);
      }).pipe(Effect.scoped, Effect.provide(persistedTestLayer)),
  );

  it.effect("is idempotent across concurrent connects and on, off and mixed transitions", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.service.connect({ ...f.detection, state: "on" });
      assert.deepEqual(first.created, ["claude", "codex"]);
      const secondContext = yield* Layer.build(Instances.layer).pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, f.wrapped),
      );
      const secondService = Context.get(secondContext, Instances.ZavodInstances);
      const racing = yield* Effect.all(
        [f.service.connect(f.detection), secondService.connect(f.detection)],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        racing.map((result) => result.created),
        [[], []],
      );
      const before = yield* f.settings.getSettings;
      const files = yield* Effect.all([
        f.fs.readFileString(f.path.join(f.root, claudeId, "settings.json")),
        f.fs.readFileString(f.path.join(f.root, codexId, "config.toml")),
      ]);
      yield* f.service.connect({ ...f.detection, state: "on" });
      yield* f.service.connect(f.detection);
      yield* f.service.connect({ ...f.detection, state: "mixed" });
      assert.deepEqual(yield* f.settings.getSettings, before);
      assert.equal(f.writes.length, 2);
      assert.deepEqual(
        yield* Effect.all([
          f.fs.readFileString(f.path.join(f.root, claudeId, "settings.json")),
          f.fs.readFileString(f.path.join(f.root, codexId, "config.toml")),
        ]),
        files,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reuses managed homes after removing instances and preserves CLI state", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.connect(f.detection);
      for (const id of [claudeId, codexId]) {
        yield* f.fs.makeDirectory(f.path.join(f.root, id, "sessions"));
        yield* f.fs.makeDirectory(f.path.join(f.root, id, "log"));
        yield* f.fs.writeFileString(f.path.join(f.root, id, "history.jsonl"), "CLI history");
        yield* f.settings.updateProviderInstance({ operation: "remove", instanceId: id });
      }
      assert.deepEqual(yield* f.service.connect(f.detection), {
        claudeInstanceId: claudeId,
        codexInstanceId: codexId,
        created: ["claude", "codex"],
      });
      assert.equal(f.writes.filter((mutation) => mutation.operation === "create").length, 4);
      for (const id of [claudeId, codexId]) {
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.root, id, "history.jsonl")),
          "CLI history",
        );
        assert.isTrue(yield* f.fs.exists(f.path.join(f.root, id, "sessions")));
        assert.isTrue(yield* f.fs.exists(f.path.join(f.root, id, "log")));
      }
      for (const id of [claudeId, codexId]) {
        yield* f.settings.updateProviderInstance({ operation: "remove", instanceId: id });
        yield* f.fs.remove(
          f.path.join(f.root, id, id === claudeId ? "settings.json" : "config.toml"),
        );
      }
      yield* f.service.connect(f.detection);
      yield* f.settings.updateProviderInstance({ operation: "remove", instanceId: claudeId });
      const foreignFile = f.path.join(f.root, claudeId, "keep.txt");
      yield* f.fs.writeFileString(foreignFile, "user data");
      yield* f.service.connect(f.detection);
      assert.equal(yield* f.fs.readFileString(foreignFile), "user data");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses foreign stable IDs and preserves manual instance IDs", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.settings.updateProviderInstance({
        operation: "create",
        instanceId: codexId,
        instance: manualInstance,
      });
      const before = yield* f.settings.getSettings;
      const error = yield* f.service.connect(f.detection).pipe(Effect.flip);
      assert.equal(error.stage, "conflict");
      assert.equal(error.instanceId, codexId);
      assert.deepEqual(yield* f.settings.getSettings, before);
      assert.deepEqual(f.writes, []);
      assert.isFalse(yield* f.fs.exists(f.root));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rolls back a failed second create, including configuration files and new homes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        beforeMutation: (mutation) =>
          mutation.operation === "create" && mutation.instanceId === codexId
            ? Effect.fail(failure())
            : Effect.void,
      });
      const before = yield* f.settings.getSettings;
      const error = yield* f.service.connect(f.detection).pipe(Effect.flip);
      assert.equal(error.stage, "write");
      assert.deepEqual(yield* f.settings.getSettings, before);
      assert.isFalse(yield* f.fs.exists(f.root));
      assert.deepEqual(
        f.writes.map((write) => write.operation),
        ["create", "create", "remove"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "preserves a concurrently edited instance and its home with an explicit rollback error",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          beforeMutation: (mutation, settings) =>
            Effect.gen(function* () {
              if (mutation.operation !== "create" || mutation.instanceId !== codexId) return;
              const claude = (yield* settings.getSettings).providerInstances[claudeId]!;
              yield* settings.updateProviderInstance({
                operation: "upsert",
                instanceId: claudeId,
                instance: { ...claude, displayName: "Human edit" },
              });
              return yield* failure();
            }),
        });
        const error = yield* f.service.connect(f.detection).pipe(Effect.flip);
        assert.equal(error.stage, "rollback");
        assert.equal(error.instanceId, claudeId);
        const settings = yield* f.settings.getSettings;
        assert.equal(settings.providerInstances[claudeId]?.displayName, "Human edit");
        assert.isUndefined(settings.providerInstances[codexId]);
        assert.isTrue(yield* f.fs.exists(f.path.join(f.root, claudeId, "settings.json")));
        assert.isFalse(yield* f.fs.exists(f.path.join(f.root, codexId)));
        assert.equal(f.writes.filter((write) => write.operation === "remove").length, 0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "refreshes owned configs while preserving user fields and restores exact files on write failure",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.service.connect(f.detection);
        const claudeFile = f.path.join(f.root, claudeId, "settings.json");
        const codexFile = f.path.join(f.root, codexId, "config.toml");
        const claudeBefore = '{"env":{"CUSTOM_SETTING":"keep"},"theme":"dark"}\n';
        const codexBefore =
          'model = "custom-model"\n[model_providers.other]\nbase_url = "https://other.example/v1"\n';
        yield* f.fs.writeFileString(claudeFile, claudeBefore);
        yield* f.fs.writeFileString(codexFile, codexBefore);
        const next = { ...f.detection, baseUrl: "https://new.example/v1" };
        const guardedFs = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) =>
            to === codexFile
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                  }),
                )
              : f.fs.rename(from, to),
        });
        const context = yield* Layer.build(Instances.layer).pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        const error = yield* Context.get(context, Instances.ZavodInstances)
          .connect(next)
          .pipe(Effect.flip);
        assert.equal(error.stage, "write");
        assert.equal(yield* f.fs.readFileString(claudeFile), claudeBefore);
        assert.equal(yield* f.fs.readFileString(codexFile), codexBefore);
        yield* f.service.connect(next);
        const claude = JSON.parse(yield* f.fs.readFileString(claudeFile));
        assert.equal(claude.env.CUSTOM_SETTING, "keep");
        assert.equal(claude.theme, "dark");
        assert.equal(claude.env.ANTHROPIC_BASE_URL, "https://new.example");
        assert.equal(parse(yield* f.fs.readFileString(codexFile)).model, "custom-model");
        assert.equal(f.writes.length, 2);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
