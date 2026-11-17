import { DESKTOP_UPDATE_IN_PROGRESS_TTL_MS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopExternalBackend from "./DesktopExternalBackend.ts";

const externalConfig = (
  overrides: Partial<DesktopBackendManager.DesktopBackendStartConfig> = {},
): DesktopBackendManager.DesktopBackendStartConfig =>
  ({
    executablePath: "electron.exe",
    entryPath: "C:/t3/apps/server/dist/bin.mjs",
    cwd: "C:/t3",
    args: [],
    env: {},
    extendEnv: true,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: 3774,
      t3Home: "C:/home",
      host: "127.0.0.1",
      desktopBootstrapToken: "token",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    bootstrapDelivery: "fd3",
    httpBaseUrl: new URL("http://127.0.0.1:3774"),
    captureOutput: false,
    preflightFailure: Option.none(),
    ...overrides,
  }) satisfies DesktopBackendManager.DesktopBackendStartConfig;

const makeSpec = (onReady: () => Effect.Effect<void>, onShutdown: () => Effect.Effect<void>) => ({
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("External server"),
  configResolve: Effect.succeed(externalConfig()),
  onReady: () => onReady(),
  onShutdown,
});

describe("DesktopExternalBackend", () => {
  it.effect("tracks server availability transitions without owning the process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let readyCount = 0;
        const instance = yield* DesktopExternalBackend.makeExternalBackendInstance(
          makeSpec(
            () =>
              Effect.gen(function* () {
                readyCount += 1;
                yield* Deferred.succeed(ready, undefined);
              }),
            () => Effect.void,
          ),
          {
            healthCheck: () => Effect.succeed(true),
          },
        );

        yield* instance.start;
        yield* Deferred.await(ready);
        assert.isTrue((yield* instance.snapshot).ready);
        assert.equal(readyCount, 1);

        yield* instance.stop();
        assert.isFalse((yield* instance.snapshot).ready);
        assert.isTrue(Option.isSome(yield* instance.currentConfig));
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("HTTP client should not be used by this test")),
        ),
      ),
    ),
  );

  it.effect("ignores isolated probe failures and shuts down after consecutive failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const probes = [true, false, true, false, false, false] as const;
        const probeIndex = yield* Ref.make(0);
        const ready = yield* Deferred.make<void>();
        const recovered = yield* Deferred.make<void>();
        const shutdown = yield* Deferred.make<void>();
        let shutdownCount = 0;
        const instance = yield* DesktopExternalBackend.makeExternalBackendInstance(
          makeSpec(
            () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
            () =>
              Effect.sync(() => {
                shutdownCount += 1;
              }).pipe(Effect.andThen(Deferred.succeed(shutdown, undefined)), Effect.asVoid),
          ),
          {
            healthCheck: () =>
              Ref.getAndUpdate(probeIndex, (index) => index + 1).pipe(
                Effect.tap((index) =>
                  index === 2 ? Deferred.succeed(recovered, undefined) : Effect.void,
                ),
                Effect.map((index) => probes[index] ?? true),
              ),
            pollInterval: Duration.seconds(2),
          },
        );

        yield* instance.start;
        yield* Deferred.await(ready);

        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Deferred.await(recovered);
        assert.equal(shutdownCount, 0);
        assert.isTrue((yield* instance.snapshot).ready);

        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Deferred.await(shutdown);
        assert.equal(shutdownCount, 1);
        assert.isFalse((yield* instance.snapshot).ready);
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("HTTP client should not be used by this test")),
            ),
          ),
        ),
      ),
    ),
  );

  it("detects ready and sustained unavailable server transitions", () => {
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(false, true), "ready");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(true, false, 1), "none");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(true, false, 2), "none");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(true, false, 3), "shutdown");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(false, false), "none");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(true, true), "none");
  });

  it("builds a client-only start config for the launcher-owned server", () => {
    const config = DesktopExternalBackend.resolveExternalStartConfig({
      port: 3774,
      bindHost: "127.0.0.1",
      httpBaseUrl: new URL("http://127.0.0.1:3774"),
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      baseDir: "C:/Users/me/.t3-v2",
      backendEntryPath: "C:/t3/apps/server/dist/bin.mjs",
      backendCwd: "C:/t3",
      bootstrapToken: "a".repeat(48),
    });

    assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:3774/");
    assert.equal(config.bootstrap.port, 3774);
    assert.equal(config.bootstrap.t3Home, "C:/Users/me/.t3-v2");
    assert.equal(config.bootstrap.desktopBootstrapToken, "a".repeat(48));
    assert.isUndefined(config.bootstrap.desktopBootstrapSecret);
    assert.deepEqual(config.args, []);
    assert.isFalse(config.captureOutput);
  });

  it.effect("reads the launcher bootstrap token from the state directory", () =>
    Effect.gen(function* () {
      const tokenPath = DesktopExternalBackend.resolveBootstrapTokenPath({
        joinPath: (...segments) => segments.join("/"),
        baseDir: "C:/Users/me/.t3-v2",
      });
      assert.equal(tokenPath, "C:/Users/me/.t3-v2/userdata/secrets/desktop-bootstrap-token");

      const token = yield* DesktopExternalBackend.readExternalBootstrapToken(
        yield* FileSystem.FileSystem.pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFileString: () => Effect.succeed("  b".concat("b".repeat(47), "\n")),
            }),
          ),
        ),
        tokenPath,
      );
      assert.equal(token, "b".repeat(48));
    }),
  );
});

it.effect.each([false, true])(
  "releases the external update marker only while unchanged %s",
  (replaced) =>
    Effect.gen(function* () {
      let reads = 0;
      let removed = false;
      const fileSystem = yield* FileSystem.FileSystem.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: (path) =>
              Effect.sync(() =>
                path.endsWith("server-runtime.json")
                  ? JSON.stringify({ port: 3774 })
                  : ++reads === 1 || !replaced
                    ? "first"
                    : "replacement",
              ),
            remove: () =>
              Effect.sync(() => {
                removed = true;
              }),
          }),
        ),
      );
      yield* DesktopExternalBackend.releaseExternalUpdateMarker(
        fileSystem,
        "/runtime/desktop-update-in-progress",
        "/runtime/server-runtime.json",
        new URL("http://127.0.0.1:3774"),
      );
      assert.equal(removed, !replaced);
    }),
);

it.effect(
  "keeps the update marker after HTTP readiness until the matching runtime is published",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let runtime = "";
        let removed = false;
        const runtimeRead = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFileString: (path) =>
                path.endsWith("server-runtime.json")
                  ? Deferred.succeed(runtimeRead, undefined).pipe(
                      Effect.andThen(Effect.sync(() => runtime)),
                    )
                  : Effect.succeed("marker"),
              remove: () =>
                Effect.sync(() => {
                  removed = true;
                }).pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid),
            }),
          ),
        );
        const instance = yield* DesktopExternalBackend.makeExternalBackendInstance(
          {
            ...makeSpec(
              () => Effect.void,
              () => Effect.void,
            ),
            onReady: (url) =>
              DesktopExternalBackend.releaseExternalUpdateMarker(
                fileSystem,
                "/runtime/desktop-update-in-progress",
                "/runtime/server-runtime.json",
                url,
              ),
          },
          { healthCheck: () => Effect.succeed(true) },
        );
        yield* instance.start;
        yield* Deferred.await(runtimeRead);
        assert.isTrue((yield* instance.snapshot).ready);
        assert.isFalse(removed);
        runtime = JSON.stringify({ port: 3775 });
        yield* TestClock.adjust("100 millis");
        assert.isFalse(removed);
        runtime = JSON.stringify({ port: 3774 });
        yield* TestClock.adjust("100 millis");
        yield* Deferred.await(released);
        assert.isTrue(removed);
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused in external readiness test")),
        ),
      ),
    ),
);

it.effect("bounds the external runtime wait by the desktop update marker TTL", () =>
  Effect.gen(function* () {
    let removed = false;
    const runtimeRead = yield* Deferred.make<void>();
    const fileSystem = yield* FileSystem.FileSystem.pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFileString: (path) =>
            path.endsWith("server-runtime.json")
              ? Deferred.succeed(runtimeRead, undefined).pipe(Effect.as(""))
              : Effect.succeed("marker"),
          remove: () =>
            Effect.sync(() => {
              removed = true;
            }),
        }),
      ),
    );
    const release = yield* DesktopExternalBackend.releaseExternalUpdateMarker(
      fileSystem,
      "/runtime/desktop-update-in-progress",
      "/runtime/server-runtime.json",
      new URL("http://127.0.0.1:3774"),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(runtimeRead);
    assert.isFalse(removed);
    yield* TestClock.adjust(Duration.millis(DESKTOP_UPDATE_IN_PROGRESS_TTL_MS));
    yield* Fiber.join(release);
    assert.isTrue(removed);
  }),
);
