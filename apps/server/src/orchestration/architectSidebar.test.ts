import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { CoordinatorArchitectRepositoryLive } from "../persistence/Layers/CoordinatorArchitect.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CoordinatorArchitectRepository,
  type BindingCreateInput,
  type ReviewInsertInput,
} from "../persistence/Services/CoordinatorArchitect.ts";
import {
  emptyArchitectSidebarSnapshot,
  loadArchitectSidebarByArchitect,
  loadArchitectSidebarByCoordinator,
} from "./architectSidebar.ts";

const repositoryLayer = it.layer(
  CoordinatorArchitectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = "2026-10-07T12:00:00.000Z";

const routingEvidence = {
  policyRef: "oc://doc/fe000000-0000-4000-8000-000000000001@10",
  policyRevision: 10,
  role: "architecture",
  taskEffort: "high",
  consideredCandidates: [
    {
      alias: "L",
      providerInstanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "max" }],
      disposition: "selected",
      reason: "First eligible target in the architecture effort cell.",
    },
  ],
} as const;

const bindingInput = (overrides: Partial<BindingCreateInput> = {}): BindingCreateInput => ({
  bindingId: "binding-fresh",
  coordinatorThreadId: "coordinator-fresh",
  architectThreadId: "arch:coordinator-fresh",
  projectId: "project-1",
  architectTaskEffort: "high",
  routingEvidence,
  createdAt: at,
  createdBy: "coordinator-fresh",
  createIdempotencyKey: "create-fresh",
  createRequestFingerprint: "fp-fresh",
  ...overrides,
});

const reviewInput = (overrides: Partial<ReviewInsertInput> = {}): ReviewInsertInput => ({
  reviewId: "review-fresh-1",
  bindingId: "binding-fresh",
  coordinatorThreadId: "coordinator-fresh",
  architectThreadId: "arch:coordinator-fresh",
  subjectChildThreadId: null,
  reason: "hard-bug",
  question: "Is the retry safe to run twice?",
  refs: {},
  executionPosture: "pause-branch",
  requestIdempotencyKey: "request-fresh-1",
  requestPayloadFingerprint: "request-fp-fresh-1",
  createdAt: at,
  ...overrides,
});

const answerInput = (reviewId: string, key: string) =>
  ({
    reviewId,
    disposition: "recommendation",
    summary: "Ship it behind a flag.",
    oclRefs: [],
    answerIdempotencyKey: `answer-${key}`,
    answerPayloadFingerprint: `ans-fp-${key}`,
    answeredAt: at,
  }) as const;

repositoryLayer("architectSidebar first snapshot", (it) => {
  it.effect("carries answered, unpublished records of the active binding on the first call", () =>
    Effect.gen(function* () {
      const repository = yield* CoordinatorArchitectRepository;
      // A replaced binding leaves an answered record behind; it must not leak
      // into the replacement binding's publishable list.
      yield* repository.createOrGetBinding(
        bindingInput({
          bindingId: "binding-stale",
          architectThreadId: "arch:stale",
          createIdempotencyKey: "create-stale",
          createRequestFingerprint: "fp-stale",
        }),
      );
      yield* repository.insertReview(
        reviewInput({
          reviewId: "review-fresh-stale",
          bindingId: "binding-stale",
          architectThreadId: "arch:stale",
          question: "Belongs to a replaced binding?",
          requestIdempotencyKey: "request-fresh-stale",
          requestPayloadFingerprint: "request-fp-fresh-stale",
        }),
      );
      assert.deepEqual(yield* repository.answerReview(answerInput("review-fresh-stale", "0")), {
        _tag: "applied",
      });
      const closed = yield* repository.closeBinding({
        bindingId: "binding-stale",
        status: "replaced",
        replacedByBindingId: "binding-fresh",
        detachReason: null,
        idempotencyKey: "detach-stale",
        closeRequestFingerprint: "close-fp-stale",
      });
      assert.strictEqual(closed?.status, "replaced");

      yield* repository.createOrGetBinding(bindingInput());

      // Answered coordinator request, unpublished: publishable with its question.
      yield* repository.insertReview(reviewInput());
      assert.deepEqual(yield* repository.answerReview(answerInput("review-fresh-1", "1")), {
        _tag: "applied",
      });

      // Unrequested Architect advice, unpublished: publishable without a question.
      const advice = yield* repository.upsertPreparedPublication({
        reviewId: "advice-fresh",
        bindingId: "binding-fresh",
        coordinatorThreadId: "coordinator-fresh",
        architectThreadId: "arch:coordinator-fresh",
        summary: "Keep the fallback path enabled.",
        disposition: "needs-human-decision",
        oclRefs: [],
        executionPosture: "continue",
        idempotencyKey: "prepare-fresh",
        payloadFingerprint: "prepare-fp-fresh",
        preparedAt: at,
      });
      assert.strictEqual(advice.origin, "architect-advice");

      // Open request: never publishable.
      yield* repository.insertReview(
        reviewInput({
          reviewId: "review-fresh-open",
          question: "Still investigating?",
          requestIdempotencyKey: "request-fresh-open",
          requestPayloadFingerprint: "request-fp-fresh-open",
        }),
      );

      // Answered then published: no longer publishable.
      yield* repository.insertReview(
        reviewInput({
          reviewId: "review-fresh-published",
          question: "Was this already shipped?",
          requestIdempotencyKey: "request-fresh-published",
          requestPayloadFingerprint: "request-fp-fresh-published",
        }),
      );
      assert.deepEqual(yield* repository.answerReview(answerInput("review-fresh-published", "2")), {
        _tag: "applied",
      });
      assert.deepEqual(
        yield* repository.publishReview({
          reviewId: "review-fresh-published",
          publishIdempotencyKey: "publish-fresh",
          publishedAt: at,
          publishedBy: "human",
        }),
        { _tag: "applied" },
      );

      // Fresh load = the very first snapshot call, with no prior events.
      const byArchitect = yield* loadArchitectSidebarByArchitect(
        repository,
        "arch:coordinator-fresh",
      );
      assert.strictEqual(byArchitect.binding?.bindingId, "binding-fresh");
      assert.strictEqual(byArchitect.binding?.status, "active");
      // Review order is (created_at, review_id): the advice row sorts first.
      assert.deepEqual(
        byArchitect.publishable.map((record) => record.reviewId),
        [advice.reviewId, "review-fresh-1"],
      );
      assert.isUndefined(byArchitect.publishable[0]?.question);
      assert.strictEqual(byArchitect.publishable[1]?.question, "Is the retry safe to run twice?");

      // The coordinator direction projects the identical list.
      const byCoordinator = yield* loadArchitectSidebarByCoordinator(
        repository,
        "coordinator-fresh",
      );
      assert.deepEqual(byCoordinator.publishable, byArchitect.publishable);
    }),
  );

  it.effect("returns an empty snapshot for an unknown Architect thread", () =>
    Effect.gen(function* () {
      const repository = yield* CoordinatorArchitectRepository;
      assert.deepEqual(
        yield* loadArchitectSidebarByArchitect(repository, "arch:unknown"),
        emptyArchitectSidebarSnapshot(),
      );
      assert.deepEqual(
        yield* loadArchitectSidebarByCoordinator(repository, "coordinator-unknown"),
        emptyArchitectSidebarSnapshot(),
      );
    }),
  );
});
