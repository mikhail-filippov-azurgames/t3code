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

export const PlanGateErrorCode = Schema.Literals([
  "plan_not_accepted",
  "plan_changed",
  "plan_phase_required",
  "plan_phase_invalid",
  "plan_step_unknown",
]);
export type PlanGateErrorCode = typeof PlanGateErrorCode.Type;

export class PlanGateError extends Schema.TaggedError<PlanGateError>()("PlanGateError", {
  code: PlanGateErrorCode,
  cardId: Schema.String,
  roleId: Schema.String,
}) {
  override get message(): string {
    switch (this.code) {
      case "plan_not_accepted":
        return `Card "${this.cardId}" needs an accepted plan before ${this.roleId} work.`;
      case "plan_phase_required":
        return `Card "${this.cardId}" requires a plan: a request to ${this.roleId} must carry plan.phase.`;
      case "plan_phase_invalid":
        return `Card "${this.cardId}" got an invalid plan.phase for ${this.roleId}.`;
      case "plan_step_unknown":
        return `The plan step is not in the accepted version of card "${this.cardId}".`;
      default:
        return `Plan for card "${this.cardId}" changed after it was accepted. Accept the current version first.`;
    }
  }
}

export interface CitedPlanVersion {
  readonly planDocId: string;
  readonly planSha256: string;
  readonly planStep?: string;
}

export interface PlanGateInput {
  readonly roleId: string;
  /** Null when the card has no plan record, which means no requirement. */
  readonly plan: Pick<PlanningContracts.PlanRecord, "required" | "state" | "acceptedSha256"> | null;
  /** Live digest of the plan document; null when the document is missing. */
  readonly liveSha256: string | null;
  /** The cited plan version; checked against the record on implement. */
  readonly citation?: CitedPlanVersion | undefined;
  /**
   * The plan phase of the letter that triggers this check (design §8). Absent
   * for plain work requests, which follow the pre-plan rules only.
   */
  readonly phase?: PlanningContracts.PlanPhase | undefined;
  /** The step the letter executes; required by the implement phase. */
  readonly step?: string | undefined;
  /** Step ids of the accepted version; checked by the implement phase. */
  readonly acceptedStepIds?: ReadonlyArray<string> | undefined;
  /** Worktree isolation of the task that carries the letter, if any. */
  readonly isolation?: string | null | undefined;
}

export type PlanGateDecision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Refuse"; readonly code: PlanGateErrorCode };

export const decidePlanGate = (input: PlanGateInput): PlanGateDecision => {
  if (!(PLAN_GATED_ROLE_IDS as ReadonlyArray<string>).includes(input.roleId)) {
    return { _tag: "Allow" };
  }
  if (input.plan === null || !input.plan.required) return { _tag: "Allow" };
  if (input.plan.state !== "accepted") {
    if (input.phase === undefined) return { _tag: "Refuse", code: "plan_phase_required" };
    if (input.phase === "implement") return { _tag: "Refuse", code: "plan_not_accepted" };
    if (input.phase === "prototype" && input.isolation !== "worktree") {
      return { _tag: "Refuse", code: "plan_phase_invalid" };
    }
    return { _tag: "Allow" };
  }
  const changed =
    input.plan.acceptedSha256 === null || input.liveSha256 !== input.plan.acceptedSha256;
  if (input.phase === undefined) {
    return changed ? { _tag: "Refuse", code: "plan_changed" } : { _tag: "Allow" };
  }
  if (input.phase === "implement") {
    if (changed) return { _tag: "Refuse", code: "plan_changed" };
    if (input.step === undefined) return { _tag: "Refuse", code: "plan_phase_invalid" };
    if (!(input.acceptedStepIds ?? []).includes(input.step)) {
      return { _tag: "Refuse", code: "plan_step_unknown" };
    }
    return { _tag: "Allow" };
  }
  return { _tag: "Allow" };
};

export class PlanGate extends Context.Service<
  PlanGate,
  {
    readonly check: (input: {
      readonly cardId: string;
      readonly roleId: string;
      readonly phase?: PlanningContracts.PlanPhase | undefined;
      readonly step?: string | undefined;
      readonly citation?: CitedPlanVersion | undefined;
      readonly isolation?: string | null | undefined;
    }) => Effect.Effect<void, PlanGateError | PlanService.PlanError>;
    /**
     * Records the state effects of an appended plan letter: the first draft
     * flags the card and creates its document, a review opens a review round,
     * an implement marks the card started. Enforced by the service, so the
     * mail side never touches plan rows directly.
     */
    readonly recordPlanLetter: (input: {
      readonly cardId: string;
      readonly phase: PlanningContracts.PlanPhase;
    }) => Effect.Effect<void, PlanService.PlanError>;
  }
>()("@t3tools/ft3-board/PlanGate") {}

export const planGateLayer = Layer.effect(
  PlanGate,
  Effect.gen(function* () {
    const plans = yield* PlanService.PlanService;
    const docs = yield* DocsServer.DocsService;

    const liveSha256Of = (plan: PlanningContracts.PlanRecord, cardId: string) =>
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
        // Card ids crossing the mail boundary carry no brand; the lookups below
        // treat an unknown id as a missing plan.
        const cardId = input.cardId as Contracts.BoardCardId;
        const plan = yield* plans.get(cardId);
        if (plan === null && input.phase !== undefined && input.phase !== "draft") {
          return yield* new PlanService.PlanError({ code: "plan_not_found", cardId: input.cardId });
        }
        const refuse = (code: PlanGateErrorCode) =>
          new PlanGateError({ code, cardId: input.cardId, roleId: input.roleId });
        const citation = input.citation;
        if (citation !== undefined && plan !== null && citation.planDocId !== plan.planDocId) {
          return yield* refuse("plan_phase_invalid");
        }
        const step = input.step ?? citation?.planStep;
        if (
          input.step !== undefined &&
          citation?.planStep !== undefined &&
          input.step !== citation.planStep
        ) {
          return yield* refuse("plan_phase_invalid");
        }
        if (input.phase === "implement") {
          if (plan?.acceptedSha256 == null) {
            return yield* refuse("plan_not_accepted");
          }
          if (citation === undefined) {
            return yield* refuse("plan_phase_invalid");
          }
          if (citation.planSha256 !== plan.acceptedSha256) {
            return yield* refuse("plan_changed");
          }
        }
        const liveSha256 =
          plan !== null && plan.required && plan.state === "accepted"
            ? yield* liveSha256Of(plan, input.cardId)
            : null;
        const acceptedStepIds =
          plan !== null && plan.required && plan.state === "accepted" && input.phase === "implement"
            ? (yield* plans.readDetail({ cardId, version: "accepted" })).stepIds
            : undefined;
        const decision = decidePlanGate({
          roleId: input.roleId,
          plan,
          liveSha256,
          phase: input.phase,
          step,
          acceptedStepIds,
          isolation: input.isolation,
        });
        if (decision._tag === "Refuse") {
          return yield* refuse(decision.code);
        }
      }),
      recordPlanLetter: Effect.fn("PlanGate.recordPlanLetter")(function* (input) {
        const cardId = input.cardId as Contracts.BoardCardId;
        if (input.phase === "draft") {
          const plan = yield* plans.get(cardId);
          if (plan === null) {
            yield* plans.require({ cardId, requiredBy: "lead" });
          }
          return;
        }
        if (input.phase === "review") {
          yield* plans.openReviewRound(cardId);
          return;
        }
        if (input.phase === "implement") {
          yield* plans.markImplementStarted(cardId);
        }
      }),
    });
  }),
);
