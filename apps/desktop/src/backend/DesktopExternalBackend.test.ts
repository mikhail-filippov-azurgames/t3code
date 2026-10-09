import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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

  it("detects ready, unavailable, and recovered server transitions", () => {
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(false, true), "ready");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(true, false), "shutdown");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(false, false), "none");
    assert.equal(DesktopExternalBackend.resolveAvailabilityTransition(true, true), "none");
  });
});
