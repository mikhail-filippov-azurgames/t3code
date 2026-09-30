/**
 * Phase 1 Coordinator/Architect wake split (§4).
 *
 * Wake rule: routine executor completion wakes the coordinator only — the
 * architect is never a `parentThreadId`, so no completion routes to it by
 * construction. The architect wakes only on explicit review request (plus the
 * §5 escalation events, which arrive as review requests) or a direct user
 * message. Ordinary answers never wake the coordinator; only an explicit
 * `publish_to_coordinator` wakes it, exactly once, proven by a
 * wake-delivered marker.
 *
 * Aggregate placement (normative): the coordinator-thread aggregate carries
 * `architect.bound`, `architect.unbound`, `architecture.review-requested-ref`,
 * `architecture.review-published`, and `architecture.publish-wake-delivered`;
 * the architect-thread aggregate carries `architecture.review-requested`,
 * `architecture.review-wake-delivered`, and `architecture.review-answered`;
 * `architecture.review-cancelled` goes to the coordinator aggregate.
 */

export const ARCHITECT_BOUND_ACTIVITY = "architect.bound" as const;
export const ARCHITECT_UNBOUND_ACTIVITY = "architect.unbound" as const;
export const REVIEW_REQUESTED_ACTIVITY = "architecture.review-requested" as const;
/** Typed no-wake coordinator reference: content without wake, by construction. */
export const REVIEW_REQUESTED_REF_ACTIVITY = "architecture.review-requested-ref" as const;
export const REVIEW_WAKE_DELIVERED_ACTIVITY = "architecture.review-wake-delivered" as const;
export const REVIEW_ANSWERED_ACTIVITY = "architecture.review-answered" as const;
export const REVIEW_CANCELLED_ACTIVITY = "architecture.review-cancelled" as const;
export const REVIEW_PUBLISHED_ACTIVITY = "architecture.review-published" as const;
export const PUBLISH_WAKE_DELIVERED_ACTIVITY = "architecture.publish-wake-delivered" as const;

export const COORDINATOR_ARCHITECT_ACTIVITY_KINDS = [
  ARCHITECT_BOUND_ACTIVITY,
  ARCHITECT_UNBOUND_ACTIVITY,
  REVIEW_REQUESTED_ACTIVITY,
  REVIEW_REQUESTED_REF_ACTIVITY,
  REVIEW_WAKE_DELIVERED_ACTIVITY,
  REVIEW_ANSWERED_ACTIVITY,
  REVIEW_CANCELLED_ACTIVITY,
  REVIEW_PUBLISHED_ACTIVITY,
  PUBLISH_WAKE_DELIVERED_ACTIVITY,
] as const;

/**
 * Activity kinds that must never unsettle or wake a settled thread. All
 * nine Phase 1 markers are content-only by construction; this set pins
 * that exclusion for the decider settled-wake predicate and tests.
 */
export const NEVER_WAKES_SETTLED_THREAD_KINDS: ReadonlySet<string> = new Set(
  COORDINATOR_ARCHITECT_ACTIVITY_KINDS,
);

/** Delegation wake anchors. The coordinator reference never enters these. */
export const DELEGATION_WAKE_ANCHOR_PREFIXES = [
  "delegation-wake:",
  "delegation-wake-turn:",
  "delegation-wake-drain:",
] as const;

export const isDelegationWakeAnchor = (id: string): boolean =>
  DELEGATION_WAKE_ANCHOR_PREFIXES.some((prefix) => id.startsWith(prefix));

export const reviewRefCommandId = (reviewId: string): string => `arch:review-ref:${reviewId}`;

export const reviewWakeMessageId = (reviewId: string): string => `arch:review-wake:${reviewId}`;
export const reviewWakeTurnCommandId = (reviewId: string): string =>
  `arch:review-wake-turn:${reviewId}`;
export const reviewWakeDeliveredMarkerId = (architectThreadId: string, reviewId: string): string =>
  `arch:review-wake-delivered:${architectThreadId}:${reviewId}`;

export const PUBLISH_WAKE_MESSAGE_PREFIX = "arch:publish-wake:" as const;
export const publishWakeMessageId = (reviewId: string): string =>
  `${PUBLISH_WAKE_MESSAGE_PREFIX}${reviewId}`;
/** The review this coordinator publish-wake turn belongs to, or null for any other message. */
export const publishWakeReviewIdFromMessageId = (messageId: string): string | null =>
  messageId.startsWith(PUBLISH_WAKE_MESSAGE_PREFIX)
    ? messageId.slice(PUBLISH_WAKE_MESSAGE_PREFIX.length) || null
    : null;
export const publishWakeTurnCommandId = (reviewId: string): string =>
  `arch:publish-wake-turn:${reviewId}`;
export const publishWakeDeliveredMarkerId = (
  coordinatorThreadId: string,
  reviewId: string,
): string => `arch:publish-wake-delivered:${coordinatorThreadId}:${reviewId}`;

export interface ActivityLike {
  readonly id?: string;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * Shared server guard (S3). One predicate, two error wrappers: `ws.ts`
 * wraps the message in `BoardError` next to `assertNotDelegatedChild`, and
 * the MCP orchestrator service wraps it in `architect_denied`.
 */
export const architectThreadViolationDetail = (threadId: string): string =>
  `Architect thread ${threadId} cannot own execution lineage or board state.`;

export const assertNotArchitectThread = (
  operation: string,
  threadId: string,
  isArchitect: boolean,
): string | null =>
  isArchitect ? `${operation}: ${architectThreadViolationDetail(threadId)}` : null;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** True when a wake-delivered marker for this review is present. */
export const hasWakeDeliveredMarker = (
  activities: ReadonlyArray<ActivityLike>,
  marker: { readonly kind: string; readonly markerId: string; readonly reviewId: string },
): boolean =>
  activities.some(
    (activity) =>
      activity.kind === marker.kind &&
      (activity.id === marker.markerId ||
        (isObject(activity.payload) && activity.payload.reviewId === marker.reviewId)),
  );

export const hasReviewWakeDelivered = (
  activities: ReadonlyArray<ActivityLike>,
  architectThreadId: string,
  reviewId: string,
): boolean =>
  hasWakeDeliveredMarker(activities, {
    kind: REVIEW_WAKE_DELIVERED_ACTIVITY,
    markerId: reviewWakeDeliveredMarkerId(architectThreadId, reviewId),
    reviewId,
  });

export const hasPublishWakeDelivered = (
  activities: ReadonlyArray<ActivityLike>,
  coordinatorThreadId: string,
  reviewId: string,
): boolean =>
  hasWakeDeliveredMarker(activities, {
    kind: PUBLISH_WAKE_DELIVERED_ACTIVITY,
    markerId: publishWakeDeliveredMarkerId(coordinatorThreadId, reviewId),
    reviewId,
  });

/** Restart replay derives a missing wake exclusively from marker absence. */
export const needsReviewWakeReplay = (
  activities: ReadonlyArray<ActivityLike>,
  architectThreadId: string,
  reviewId: string,
): boolean => !hasReviewWakeDelivered(activities, architectThreadId, reviewId);

export const needsPublishWakeReplay = (
  activities: ReadonlyArray<ActivityLike>,
  coordinatorThreadId: string,
  reviewId: string,
): boolean => !hasPublishWakeDelivered(activities, coordinatorThreadId, reviewId);
