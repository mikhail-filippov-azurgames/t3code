import { DelegationLaunchPolicy } from "@t3tools/ft3-delegation/server";
import { DEFAULT_DELEGATED_ROLE, FeatureGate } from "@t3tools/ft3-policies/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** With mail on, a delegated role must run as a mail participant; with mail off, delegation stays upstream. */
export const mailDelegationLaunchLayer: Layer.Layer<DelegationLaunchPolicy, never, FeatureGate> =
  Layer.effect(
    DelegationLaunchPolicy,
    Effect.gen(function* () {
      const gate = yield* FeatureGate;
      return DelegationLaunchPolicy.of({
        launchFor: Effect.fn("DelegationLaunchPolicy.mail")(function* (role: string | undefined) {
          if (!(yield* gate.isEffective("mail"))) return { _tag: "direct" } as const;
          return { _tag: "mail_required", role: role ?? DEFAULT_DELEGATED_ROLE } as const;
        }),
      });
    }),
  );
