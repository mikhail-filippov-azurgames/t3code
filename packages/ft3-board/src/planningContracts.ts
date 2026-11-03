import * as Schema from "effect/Schema";

export const PLAN_STATES = [
  "required",
  "drafting",
  "reviewing",
  "discussion",
  "accepted",
  "withdrawn",
] as const;
export const PlanState = Schema.Literals(PLAN_STATES);
export type PlanState = typeof PlanState.Type;

export const PLAN_REASONS = ["contracts", "storage", "multi_package", "upstream"] as const;
export const PlanReason = Schema.Literals(PLAN_REASONS);
export type PlanReason = typeof PlanReason.Type;

export const PlanRequiredBy = Schema.Literals(["human", "lead"]);
export type PlanRequiredBy = typeof PlanRequiredBy.Type;

export const PlanVersionPhase = Schema.Literals([
  "draft",
  "review_1",
  "review_2",
  "discussion",
  "accepted",
]);
export type PlanVersionPhase = typeof PlanVersionPhase.Type;

export const PlanRecord = Schema.Struct({
  cardId: Schema.String,
  required: Schema.Boolean,
  requiredBy: PlanRequiredBy,
  requiredReason: Schema.NullOr(PlanReason),
  state: PlanState,
  planDocId: Schema.String,
  plannerMemberId: Schema.NullOr(Schema.String),
  plannerThreadId: Schema.NullOr(Schema.String),
  reviewRounds: Schema.Number,
  acceptedSha256: Schema.NullOr(Schema.String),
  acceptedRevision: Schema.Number,
  acceptedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PlanRecord = typeof PlanRecord.Type;
