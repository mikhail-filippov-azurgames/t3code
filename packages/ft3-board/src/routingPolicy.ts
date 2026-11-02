import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const ROUTING_POLICY_REF_ENV = "T3CODE_FT3_ROUTING_POLICY_REF";

/** Mirrors the `PolicyDocumentRef` bound on `routingEvidence.policyRef`. */
export const ROUTING_POLICY_REF_MAX_LENGTH = 64;

// Server setting: the routing-policy reference the board brief and architect must follow.
export const routingPolicyRef: Effect.Effect<string, never> = Config.String(
  ROUTING_POLICY_REF_ENV,
).pipe(
  Config.withDefault(""),
  Effect.orElseSucceed(() => ""),
  Effect.map((configured) => configured.trim()),
  Effect.filterOrElse(
    (ref: string) => ref.length <= ROUTING_POLICY_REF_MAX_LENGTH,
    (ref) =>
      Effect.die(
        new Error(
          `${ROUTING_POLICY_REF_ENV} is ${ref.length} characters long; the routing policy reference must be at most ${ROUTING_POLICY_REF_MAX_LENGTH} characters. Use a short policy id instead of a file path.`,
        ),
      ),
  ),
);
