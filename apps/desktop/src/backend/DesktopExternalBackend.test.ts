import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopExternalBackend from "./DesktopExternalBackend.ts";

const makeSpec = (onReady: () => Effect.Effect<void>, onShutdown: () => Effect.Effect<void>) => ({
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("External server"),
  configResolve: Effect.succeed({} as DesktopBackendManager.DesktopBackendStartConfig),
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
});
