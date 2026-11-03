import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DelegationLaunchPolicy, neverMailRequiredLayer } from "./delegationLaunch.ts";

describe("ft3 delegation launch", () => {
  it.effect("launches every role directly while no role requires mail", () =>
    Effect.gen(function* () {
      const policy = yield* DelegationLaunchPolicy;
      assert.deepEqual(yield* policy.launchFor(undefined), { _tag: "direct" });
      assert.deepEqual(yield* policy.launchFor("general"), { _tag: "direct" });
      assert.deepEqual(yield* policy.launchFor("architect-data"), { _tag: "direct" });
    }).pipe(Effect.provide(neverMailRequiredLayer)),
  );
});
