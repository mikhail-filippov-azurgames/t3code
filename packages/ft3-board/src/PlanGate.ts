/**
 * The server gate for delegated work on a card that requires a plan (design
 * §11.4). A flagged card keeps the gate until its plan is accepted and still
 * matches; the `planning` toggle only controls setting new flags.
 */
import * as DocsServer from "@t3tools/ft3-docs/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { docLinkOf } from "@t3tools/ft3-docs/contracts";

import type * as Contracts from "./contracts.ts";
import * as PlanService from "./PlanService.ts";
import type * as PlanningContracts from "./planningContracts.ts";

export const PLAN_GATED_ROLE_IDS = ["implementation", "general", "test"] as const;

export const PlanGateErrorCode = Schema.Literals(["plan_not_accepted", "plan_changed"]);
export type PlanGateErrorCode = typeof PlanGateErrorCode.Type;

export class PlanGateError extends Schema.TaggedError<PlanGateError>()("PlanGateError", {
  code: PlanGateErrorCode,
  cardId: Schema.String,
  roleId: Schema.String,
}) {
  override get message(): string {
    return this.code === "plan_not_accepted"
      ? `Card "${this.cardId}" needs an accepted plan before ${this.roleId} work.`
      : `Plan for card "${this.cardId}" changed after it was accepted. Accept the current version first.`;
  }
}

export interface PlanGateInput {
  readonly roleId: string;
  /** Null when the card has no plan record, which means no requirement. */
  readonly plan: Pick<PlanningContracts.PlanRecord, "required" | "state" | "acceptedSha256"> | null;
  /** Live digest of the plan document; null when the document is missing. */
  readonly liveSha256: string | null;
}

export type PlanGateDecision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Refuse"; readonly code: PlanGateErrorCode };

export const decidePlanGate = (input: PlanGateInput): PlanGateDecision => {
  if (!(PLAN_GATED_ROLE_IDS as ReadonlyArray<string>).includes(input.roleId)) {
    return { _tag: "Allow" };
  }
  if (input.plan === null || !input.plan.required) return { _tag: "Allow" };
  if (input.plan.state !== "accepted") return { _tag: "Refuse", code: "plan_not_accepted" };
  if (input.plan.acceptedSha256 === null || input.liveSha256 !== input.plan.acceptedSha256) {
    return { _tag: "Refuse", code: "plan_changed" };
  }
  return { _tag: "Allow" };
};

export class PlanGate extends Context.Service<
  PlanGate,
  {
    readonly check: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly roleId: string;
    }) => Effect.Effect<void, PlanGateError | PlanService.PlanError>;
  }
>()("@t3tools/ft3-board/PlanGate") {}

export const planGateLayer = Layer.effect(
  PlanGate,
  Effect.gen(function* () {
    const plans = yield* PlanService.PlanService;
    const docs = yield* DocsServer.DocsService;

    const liveSha256Of = (plan: PlanningContracts.PlanRecord, cardId: Contracts.BoardCardId) =>
      docs.docRef(docLinkOf(plan.planDocId)).pipe(
        Effect.map((ref) => ref.sha256 ?? null),
        Effect.catch((error) =>
          error.code === "document_not_found"
            ? Effect.succeed(null)
            : Effect.fail(
                new PlanService.PlanError({ code: "plan_document_failed", cardId, cause: error }),
              ),
        ),
      );

    return PlanGate.of({
      check: Effect.fn("PlanGate.check")(function* (input) {
        const plan = yield* plans.get(input.cardId);
        const liveSha256 =
          plan !== null && plan.required && plan.state === "accepted"
            ? yield* liveSha256Of(plan, input.cardId)
            : null;
        const decision = decidePlanGate({ roleId: input.roleId, plan, liveSha256 });
        if (decision._tag === "Refuse") {
          return yield* new PlanGateError({
            code: decision.code,
            cardId: input.cardId,
            roleId: input.roleId,
          });
        }
      }),
    });
  }),
);
