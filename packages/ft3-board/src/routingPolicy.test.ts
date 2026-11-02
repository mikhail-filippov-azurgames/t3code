import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  ROUTING_POLICY_REF_ENV,
  ROUTING_POLICY_REF_MAX_LENGTH,
  routingPolicyRef,
} from "./routingPolicy.ts";

const readRef = (env: Record<string, string>) =>
  routingPolicyRef.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

describe("ft3 routing policy reference", () => {
  it.effect(
    "fails to start when the configured reference exceeds the policy document bound",
    () => {
      const tooLong = `policies/board-routing-policy-${"a".repeat(60)}.md`;
      return Effect.gen(function* () {
        assert.isAbove(tooLong.length, ROUTING_POLICY_REF_MAX_LENGTH);
        const exit = yield* Effect.exit(readRef({ [ROUTING_POLICY_REF_ENV]: tooLong }));
        assert.isTrue(Exit.isFailure(exit));
        const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
        assert.instanceOf(defect, Error);
        const message = String((defect as Error).message);
        assert.include(message, ROUTING_POLICY_REF_ENV);
        assert.include(message, String(tooLong.length));
        assert.include(message, String(ROUTING_POLICY_REF_MAX_LENGTH));
      });
    },
  );

  it.effect("allows an unset reference and trims a configured one", () => {
    return Effect.gen(function* () {
      assert.equal(yield* readRef({}), "");
      assert.equal(
        yield* readRef({ [ROUTING_POLICY_REF_ENV]: "  policy:configured  " }),
        "policy:configured",
      );
      assert.equal(
        yield* readRef({ [ROUTING_POLICY_REF_ENV]: "p".repeat(ROUTING_POLICY_REF_MAX_LENGTH) }),
        "p".repeat(ROUTING_POLICY_REF_MAX_LENGTH),
      );
    });
  });
});
