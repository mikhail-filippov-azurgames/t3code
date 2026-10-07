import * as Effect from "effect/Effect";
import type {
  ArchitectureReviewRecord,
  ArchitectureReviewStatus,
  CoordinatorArchitectBinding,
  OrchestratorMcpCoordinatorArchitectSidebarSnapshot,
  OrchestratorMcpPublishableRecord,
} from "@t3tools/contracts";

/**
 * Shared builder for the Coordinator Architect sidebar snapshot (the human
 * Publish button's read model). Both snapshot endpoints — by coordinator and
 * by architect — must project the same `publishable` list: the `answered`
 * records of the **active** binding that already carry an answer summary and
 * disposition. Published, open, cancelled, and foreign-binding records never
 * qualify.
 */
export const toPublishableRecords = (
  binding: CoordinatorArchitectBinding,
  reviews: ReadonlyArray<ArchitectureReviewRecord>,
): ReadonlyArray<OrchestratorMcpPublishableRecord> =>
  reviews.flatMap((review) =>
    review.bindingId === binding.bindingId &&
    review.status === "answered" &&
    review.answerSummary !== null &&
    review.answerDisposition !== null
      ? [
          {
            reviewId: review.reviewId,
            origin: review.origin,
            summary: review.answerSummary,
            disposition: review.answerDisposition,
            refs: review.refs,
            ...(review.origin === "coordinator-request" ? { question: review.question } : {}),
          },
        ]
      : [],
  );

export const buildArchitectSidebarSnapshot = (
  binding: CoordinatorArchitectBinding,
  reviews: ReadonlyArray<ArchitectureReviewRecord>,
): OrchestratorMcpCoordinatorArchitectSidebarSnapshot => ({
  binding,
  reviews,
  publishable: toPublishableRecords(binding, reviews),
});

export const emptyArchitectSidebarSnapshot =
  (): OrchestratorMcpCoordinatorArchitectSidebarSnapshot => ({
    binding: null,
    reviews: [],
    publishable: [],
  });

/**
 * Minimal store surface the snapshot loaders need. It matches the repository
 * shape structurally, so the loaders run against the real SQLite layers in
 * tests with no mocks.
 */
export interface ArchitectSidebarStore<E> {
  readonly getActiveBindingByCoordinator: (
    coordinatorThreadId: string,
  ) => Effect.Effect<CoordinatorArchitectBinding | null, E>;
  readonly getActiveBindingByArchitect: (
    architectThreadId: string,
  ) => Effect.Effect<CoordinatorArchitectBinding | null, E>;
  readonly listReviewsByCoordinator: (input: {
    readonly coordinatorThreadId: string;
    readonly status?: ArchitectureReviewStatus;
  }) => Effect.Effect<ReadonlyArray<ArchitectureReviewRecord>, E>;
}

export const loadArchitectSidebarByCoordinator = <E>(
  store: ArchitectSidebarStore<E>,
  coordinatorThreadId: string,
): Effect.Effect<OrchestratorMcpCoordinatorArchitectSidebarSnapshot, E> =>
  Effect.gen(function* () {
    const binding = yield* store.getActiveBindingByCoordinator(coordinatorThreadId);
    if (binding === null) return emptyArchitectSidebarSnapshot();
    const reviews = yield* store.listReviewsByCoordinator({ coordinatorThreadId });
    return buildArchitectSidebarSnapshot(binding, reviews);
  });

/**
 * Reverse lookup for a fresh Architect-thread load. The composer knows its
 * own thread id on the first render, before any sidebar pin reports the
 * coordinator mapping — so the first snapshot must already carry the
 * publishable list instead of waiting for the report cascade.
 */
export const loadArchitectSidebarByArchitect = <E>(
  store: ArchitectSidebarStore<E>,
  architectThreadId: string,
): Effect.Effect<OrchestratorMcpCoordinatorArchitectSidebarSnapshot, E> =>
  Effect.gen(function* () {
    const binding = yield* store.getActiveBindingByArchitect(architectThreadId);
    if (binding === null) return emptyArchitectSidebarSnapshot();
    const reviews = yield* store.listReviewsByCoordinator({
      coordinatorThreadId: binding.coordinatorThreadId,
    });
    return buildArchitectSidebarSnapshot(binding, reviews);
  });
