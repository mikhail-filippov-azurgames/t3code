import { assert, it } from "@effect/vitest";
import { DelegationLaunchPolicy } from "@t3tools/ft3-delegation/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { mailDelegationLaunchLayer } from "./delegationLaunch.ts";
import { gateLayer } from "./mail.testkit.ts";

const launchOn = mailDelegationLaunchLayer.pipe(Layer.provide(gateLayer(true)));
const launchOff = mailDelegationLaunchLayer.pipe(Layer.provide(gateLayer(false)));

const launchOf = (role: string | undefined) =>
  Effect.gen(function* () {
    const policy = yield* DelegationLaunchPolicy;
    return yield* policy.launchFor(role);
  });

it.effect("launches a delegated role as a mail participant only while mail is on", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* launchOf("design").pipe(Effect.provide(launchOn)), {
      _tag: "mail_required",
      role: "design",
    });
    assert.deepStrictEqual(yield* launchOf(undefined).pipe(Effect.provide(launchOn)), {
      _tag: "mail_required",
      role: "general",
    });
    assert.deepStrictEqual(yield* launchOf("design").pipe(Effect.provide(launchOff)), {
      _tag: "direct",
    });
  }),
);
