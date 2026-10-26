import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const ROUTING_POLICY_REF_ENV = "T3CODE_FT3_ROUTING_POLICY_REF";

// Server setting: the routing-policy reference the board brief and architect must follow.
export const routingPolicyRef: Effect.Effect<string, never> = Config.String(
  ROUTING_POLICY_REF_ENV,
).pipe(
  Config.withDefault(""),
  Effect.orElseSucceed(() => ""),
);
