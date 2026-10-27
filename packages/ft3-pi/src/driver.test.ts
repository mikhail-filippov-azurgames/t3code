import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";

import { Ft3PiDriver } from "./driver.ts";

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();

const makeSpawner = Effect.fnUntraced(function* () {
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("Unexpected pipeline command");
      }
      launches.push(command);
      const version = command.args.includes("--version") || command.command.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          const data =
            request.type === "get_commands"
              ? { commands: [] }
              : request.type === "get_available_models"
                ? { models: [{ provider: "test", id: "model" }] }
                : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: true, data })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version ? Stream.succeed(encoder.encode("pi 0.87.1\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches };
});

const makeLayer = (root: string, spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => {
  const settings = { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false };
  const host = Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: root,
        baseDir: root,
        stateDir: `${root}/userdata`,
        providerStatusCacheDir: `${root}/caches`,
        attachmentsDir: `${root}/attachments`,
      },
      settings: {
        get: Effect.succeed(settings),
        withSnapshot: (use) => use(settings),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(false),
      resolveAttachmentPath: () => null,
      credentials: () =>
        Effect.succeed({
          binding: { owner: "t3", key: "test" },
          get: Effect.succeedNone,
          set: () => Effect.void,
          remove: Effect.void,
        }),
    }),
  );
  return Layer.mergeAll(
    host,
    IdAllocator.layer,
    McpProviderSessions.layer,
    ProviderLatestVersions.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP")),
    ),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

it.effect("runs the availability probe through the bundled launcher", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-driver-" });
    const { spawner, launches } = yield* makeSpawner();
    const launcher = path.join(
      root,
      "userdata",
      "pi",
      "pi",
      "runtime",
      process.platform === "win32" ? "pi.cmd" : "pi",
    );

    yield* Effect.gen(function* () {
      const instance = yield* Ft3PiDriver.create({
        instanceId: ProviderInstanceId.make("pi"),
        displayName: "Pi",
        environment: [{ name: "CODEX_HOME", value: path.join(root, "codex"), sensitive: false }],
        enabled: true,
        config: { ...Ft3PiDriver.defaultConfig(), binaryPath: "pi" },
      });
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;

      assert.isTrue(yield* fileSystem.exists(launcher));
      assert.isTrue(snapshot.installed);
      assert.equal(snapshot.version, "0.87.1");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default", "test/model"],
      );
      assert.notInclude(
        launches.map((launch) => launch.command),
        "pi",
      );
      assert.isTrue(
        launches.some((launch) => launch.command.includes("pi.cmd")) ||
          launches.some((launch) => launch.command === launcher),
      );
    }).pipe(Effect.provide(makeLayer(root, spawner)), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
