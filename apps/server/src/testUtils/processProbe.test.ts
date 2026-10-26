import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

import { isExpectedProbeSocketError, makeProcessProbe } from "./processProbe.ts";

it("ignores the reset and broken pipe a killed probe client leaves behind", () => {
  assert.isTrue(
    isExpectedProbeSocketError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
  );
  assert.isTrue(
    isExpectedProbeSocketError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
  );
});

it("does not hide unrelated socket errors", () => {
  assert.isFalse(
    isExpectedProbeSocketError(Object.assign(new Error("connect EACCES"), { code: "EACCES" })),
  );
  assert.isFalse(isExpectedProbeSocketError(new Error("boom")));
  assert.isFalse(isExpectedProbeSocketError(undefined));
});

// A reset without a socket error listener escapes as an uncaught exception and fails the run.
it.effect("treats a client reset as the probe exiting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      const client = NodeNet.connect(probe.port, "127.0.0.1");

      yield* Effect.gen(function* () {
        yield* Effect.callback<void, Error>((resume) => {
          client.once("connect", () => resume(Effect.void));
          client.once("error", (error) => resume(Effect.fail(error)));
        });

        client.resetAndDestroy();

        yield* probe.exited;
      }).pipe(Effect.ensuring(Effect.sync(() => client.destroy())));
    }),
  ),
);
