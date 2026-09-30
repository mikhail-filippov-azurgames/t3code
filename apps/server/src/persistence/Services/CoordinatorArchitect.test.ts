// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { CoordinatorArchitectRepositoryLive } from "../Layers/CoordinatorArchitect.ts";
import {
  CoordinatorArchitectIdempotencyConflict,
  CoordinatorArchitectRepository,
  type BindingCreateInput,
  type ReviewInsertInput,
} from "./CoordinatorArchitect.ts";

const repositoryLayer = it.layer(
  CoordinatorArchitectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = "2026-09-28T12:00:00.000Z";

const routingEvidence = {
  policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10",
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
  bindingId: "binding-1",
  coordinatorThreadId: "coordinator-1",
  architectThreadId: "arch:coordinator-1",
  projectId: "project-1",
  architectTaskEffort: "high",
  routingEvidence,
  createdAt: at,
  createdBy: "coordinator-1",
  createIdempotencyKey: "create-1",
  createRequestFingerprint: "fp-1",
  ...overrides,
});

const reviewInput = (overrides: Partial<ReviewInsertInput> = {}): ReviewInsertInput => ({
  reviewId: "review-1",
  bindingId: "binding-1",
  coordinatorThreadId: "coordinator-1",
  architectThreadId: "arch:coordinator-1",
  subjectChildThreadId: null,
  reason: "hard-bug",
  question: "Is the retry safe to run twice?",
  refs: { oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174001"] },
  executionPosture: "pause-branch",
  requestIdempotencyKey: "request-1",
  requestPayloadFingerprint: "request-fp-1",
  createdAt: at,
  ...overrides,
});

repositoryLayer("CoordinatorArchitectRepository", (it) => {
  it.effect("S2 spike: BEGIN IMMEDIATE cannot be nested inside withTransaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.withTransaction(sql`BEGIN IMMEDIATE`));
      assert.isTrue(SqlError.isSqlError(error));
      assert.match(String(error.reason.cause).toLowerCase(), /transaction/);
    }),
  );

  it.effect("creates binding tables with migration 058 and no backfill", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN ('coordinator_architect_binding', 'architecture_review')
        ORDER BY name ASC
      `;
      assert.deepEqual(
        [...tables].map((row) => row.name),
        ["architecture_review", "coordinator_architect_binding"],
      );
      const repository = yield* CoordinatorArchitectRepository;
      // Legacy threads open as coordinators with no binding.
      assert.isNull(yield* repository.getActiveBindingByCoordinator("legacy-thread"));
    }),
  );

  it.effect("elects one winner on repeat create and conflicts on fingerprint change", () =>
    Effect.gen(function* () {
      const repository = yield* CoordinatorArchitectRepository;
      const first = yield* repository.createOrGetBinding(bindingInput());
      assert.isTrue(first.created);
      assert.strictEqual(first.binding.bindingId, "binding-1");
      assert.strictEqual(first.binding.status, "active");

      const replay = yield* repository.createOrGetBinding(bindingInput());
      assert.isFalse(replay.created);
      assert.strictEqual(replay.binding.bindingId, "binding-1");

      // Repeat create with a different key still returns the existing binding.
      const otherKey = yield* repository.createOrGetBinding(
        bindingInput({
          bindingId: "binding-2",
          architectThreadId: "arch:other",
          createIdempotencyKey: "create-2",
          createRequestFingerprint: "fp-2",
        }),
      );
      assert.isFalse(otherKey.created);
      assert.strictEqual(otherKey.binding.bindingId, "binding-1");

      // Same key + different fingerprint is an exact-retry conflict.
      const conflict = yield* Effect.flip(
        repository.createOrGetBinding(bindingInput({ createRequestFingerprint: "fp-changed" })),
      );
      assert.instanceOf(conflict, CoordinatorArchitectIdempotencyConflict);
    }),
  );

  it.effect("runs the review state machine with first-wins answers", () =>
    Effect.gen(function* () {
      const repository = yield* CoordinatorArchitectRepository;
      yield* repository.createOrGetBinding(bindingInput());

      const inserted = yield* repository.insertReview(reviewInput());
      assert.isTrue(inserted.created);
      assert.strictEqual(inserted.review.status, "open");
      assert.isNull(inserted.review.answerDisposition);

      const reinserted = yield* repository.insertReview(reviewInput());
      assert.isFalse(reinserted.created);
      assert.strictEqual(reinserted.review.reviewId, "review-1");
      const requestConflict = yield* Effect.flip(
        repository.insertReview(reviewInput({ requestPayloadFingerprint: "request-fp-changed" })),
      );
      assert.instanceOf(requestConflict, CoordinatorArchitectIdempotencyConflict);

      const answered = yield* repository.answerReview({
        reviewId: "review-1",
        disposition: "recommendation",
        summary: "Ship it.",
        oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174002"],
        answerIdempotencyKey: "answer-1",
        answerPayloadFingerprint: "ans-fp-1",
        answeredAt: at,
      });
      assert.deepEqual(answered, { _tag: "applied" });

      const answerReplay = yield* repository.answerReview({
        reviewId: "review-1",
        disposition: "recommendation",
        summary: "Ship it.",
        oclRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174002"],
        answerIdempotencyKey: "answer-1",
        answerPayloadFingerprint: "ans-fp-1",
        answeredAt: at,
      });
      assert.deepEqual(answerReplay, { _tag: "replay" });

      const answerConflict = yield* repository.answerReview({
        reviewId: "review-1",
        disposition: "needs-human-decision",
        summary: "Ship it.",
        oclRefs: [],
        answerIdempotencyKey: "answer-1",
        answerPayloadFingerprint: "ans-fp-2",
        answeredAt: at,
      });
      assert.deepEqual(answerConflict, { _tag: "conflict" });
      const stored = yield* repository.getReviewById("review-1");
      assert.strictEqual(stored?.answerDisposition, "recommendation");
      assert.deepEqual(stored?.refs.oclRefs, ["oc://doc/123e4567-e89b-42d3-a456-426614174001"]);
      assert.deepEqual(stored?.refs.architectOclRefs, [
        "oc://doc/123e4567-e89b-42d3-a456-426614174002",
      ]);

      // The status filter is optional for the sidebar and startup reconciliation.
      const listedWithoutStatus = yield* repository.listReviewsByCoordinator({
        coordinatorThreadId: "coordinator-1",
      });
      assert.deepEqual(listedWithoutStatus[0]?.refs.architectOclRefs, [
        "oc://doc/123e4567-e89b-42d3-a456-426614174002",
      ]);

      const cancelThenPublish = yield* repository.publishReview({
        reviewId: "review-1",
        publishIdempotencyKey: "publish-1",
        publishedAt: at,
      });
      assert.deepEqual(cancelThenPublish, { _tag: "applied" });
      const publishReplay = yield* repository.publishReview({
        reviewId: "review-1",
        publishIdempotencyKey: "publish-1",
        publishedAt: at,
      });
      assert.deepEqual(publishReplay, { _tag: "replay" });
      // Publish-then-cancel is rejected: published is terminal.
      const lateCancel = yield* repository.cancelReview({
        reviewId: "review-1",
        cancelIdempotencyKey: "cancel-1",
        cancelPayloadFingerprint: "cancel-fp-1",
        cancelledAt: at,
        cancelledBy: "coordinator-1",
      });
      assert.deepEqual(lateCancel, { _tag: "state" });
    }),
  );

  it.effect("tracks publish delivery and failure without touching status", () =>
    Effect.gen(function* () {
      // Unique ids: the layer DB is shared across this file's tests.
      const repository = yield* CoordinatorArchitectRepository;
      yield* repository.createOrGetBinding(
        bindingInput({
          bindingId: "binding-delivery",
          coordinatorThreadId: "coordinator-delivery",
          architectThreadId: "arch:coordinator-delivery",
        }),
      );
      yield* repository.insertReview(
        reviewInput({
          reviewId: "review-delivery",
          bindingId: "binding-delivery",
          coordinatorThreadId: "coordinator-delivery",
          architectThreadId: "arch:coordinator-delivery",
        }),
      );
      // Fresh reviews carry no delivery state.
      const fresh = yield* repository.getReviewById("review-delivery");
      assert.isNull(fresh?.publishDeliveredAt);
      assert.isNull(fresh?.lastPublishFailure);
      yield* repository.answerReview({
        reviewId: "review-delivery",
        disposition: "recommendation",
        summary: "Ship it.",
        oclRefs: [],
        answerIdempotencyKey: "answer-delivery",
        answerPayloadFingerprint: "ans-delivery-fp",
        answeredAt: at,
      });
      yield* repository.recordPublishFailure({
        reviewId: "review-delivery",
        reason: "parent_scope_drift",
        message: "refused [reason=parent_scope_drift]",
        attemptedAt: at,
      });
      const refused = yield* repository.getReviewById("review-delivery");
      // A recorded answer without delivery stays distinguishable from no
      // answer, and the refusal reason is durable with status untouched.
      assert.strictEqual(refused?.status, "answered");
      assert.isNotNull(refused?.answeredAt);
      assert.isNull(refused?.publishDeliveredAt);
      assert.deepEqual(refused?.lastPublishFailure, {
        reason: "parent_scope_drift",
        message: "refused [reason=parent_scope_drift]",
        attemptedAt: at,
      });
      const listed = yield* repository.listReviewsByCoordinator({
        coordinatorThreadId: "coordinator-delivery",
      });
      assert.deepEqual(listed[0]?.lastPublishFailure?.reason, "parent_scope_drift");
      yield* repository.publishReview({
        reviewId: "review-delivery",
        publishIdempotencyKey: "publish-delivery",
        publishedAt: at,
      });
      yield* repository.markPublishDelivered({
        reviewId: "review-delivery",
        deliveredAt: at,
      });
      const delivered = yield* repository.getReviewById("review-delivery");
      assert.strictEqual(delivered?.status, "published");
      assert.strictEqual(delivered?.publishDeliveredAt, at);
      assert.isNull(delivered?.lastPublishFailure);
    }),
  );

  it.effect("cancels from open and answered with idempotent replay and no wake", () =>
    Effect.gen(function* () {
      // Unique ids: the layer DB is shared across this file's tests.
      const coordinatorThreadId = "coordinator-2";
      const binding = bindingInput({
        bindingId: "binding-2",
        coordinatorThreadId,
        architectThreadId: "arch:coordinator-2",
      });
      const review = reviewInput({
        reviewId: "review-2",
        bindingId: "binding-2",
        coordinatorThreadId,
        architectThreadId: "arch:coordinator-2",
      });
      const repository = yield* CoordinatorArchitectRepository;
      yield* repository.createOrGetBinding(binding);
      yield* repository.insertReview(review);
      const cancelled = yield* repository.cancelReview({
        reviewId: "review-2",
        cancelIdempotencyKey: "cancel-1",
        cancelPayloadFingerprint: "cancel-fp-1",
        cancelledAt: at,
        cancelledBy: "human",
      });
      assert.deepEqual(cancelled, { _tag: "applied" });
      const replay = yield* repository.cancelReview({
        reviewId: "review-2",
        cancelIdempotencyKey: "cancel-1",
        cancelPayloadFingerprint: "cancel-fp-1",
        cancelledAt: at,
        cancelledBy: "human",
      });
      assert.deepEqual(replay, { _tag: "replay" });
      const cancelConflict = yield* repository.cancelReview({
        reviewId: "review-2",
        cancelIdempotencyKey: "cancel-1",
        cancelPayloadFingerprint: "cancel-fp-changed",
        cancelledAt: at,
        cancelledBy: "human",
      });
      assert.deepEqual(cancelConflict, { _tag: "conflict" });
      // Cancel-then-publish is rejected typed.
      const latePublish = yield* repository.publishReview({
        reviewId: "review-2",
        publishIdempotencyKey: "publish-1",
        publishedAt: at,
      });
      assert.deepEqual(latePublish, { _tag: "state" });
      const stored = yield* repository.getReviewById("review-2");
      assert.strictEqual(stored?.status, "cancelled");
    }),
  );

  it.effect("soft-deletes on detach: audit retained, never resurrected", () =>
    Effect.gen(function* () {
      // Unique ids: the layer DB is shared across this file's tests.
      const repository = yield* CoordinatorArchitectRepository;
      yield* repository.createOrGetBinding(
        bindingInput({
          bindingId: "binding-3",
          coordinatorThreadId: "coordinator-3",
          architectThreadId: "arch:coordinator-3",
        }),
      );
      const closed = yield* repository.closeBinding({
        bindingId: "binding-3",
        status: "detached",
        replacedByBindingId: null,
        detachReason: "permanent rollback",
        idempotencyKey: "detach-1",
        closeRequestFingerprint: "close-fp-1",
      });
      assert.strictEqual(closed?.status, "detached");
      assert.isNull(yield* repository.getActiveBindingByCoordinator("coordinator-3"));
      assert.isNull(yield* repository.getActiveBindingByArchitect("arch:coordinator-3"));
      // Purge is out of Phase 1: the row is retained, only unreachable.
      const retained = yield* repository.getBindingById("binding-3");
      assert.strictEqual(retained?.status, "detached");
      assert.strictEqual(retained?.detachReason, "permanent rollback");
    }),
  );

  it.effect("lists bindings and replays detach/replace with routing evidence intact", () =>
    Effect.gen(function* () {
      const repository = yield* CoordinatorArchitectRepository;
      const detachedInput = bindingInput({
        bindingId: "binding-replay-detach",
        coordinatorThreadId: "coordinator-replay-detach",
        architectThreadId: "arch:replay-detach",
      });
      yield* repository.createOrGetBinding(detachedInput);
      const listed = yield* repository.listBindingsByCoordinator("coordinator-replay-detach");
      assert.deepEqual(listed[0]?.routingEvidence, routingEvidence);
      yield* repository.closeBinding({
        bindingId: detachedInput.bindingId,
        status: "detached",
        replacedByBindingId: null,
        detachReason: "detach replay regression",
        idempotencyKey: "detach-replay-key",
        closeRequestFingerprint: "detach-replay-fingerprint",
      });
      const detachReplay = yield* repository.findDetachReplay({
        coordinatorThreadId: "coordinator-replay-detach",
        closeIdempotencyKey: "detach-replay-key",
        closeRequestFingerprint: "detach-replay-fingerprint",
      });
      assert.strictEqual(detachReplay?.bindingId, detachedInput.bindingId);
      assert.deepEqual(detachReplay?.routingEvidence, routingEvidence);

      const replacedInput = bindingInput({
        bindingId: "binding-replay-replace",
        coordinatorThreadId: "coordinator-replay-replace",
        architectThreadId: "arch:replay-replace",
      });
      yield* repository.createOrGetBinding(replacedInput);
      yield* repository.closeBinding({
        bindingId: replacedInput.bindingId,
        status: "replaced",
        replacedByBindingId: null,
        detachReason: "replace replay regression",
        idempotencyKey: "replace-replay-key",
        closeRequestFingerprint: "replace-replay-fingerprint",
      });
      const closedBeforeWinner = yield* repository.getBindingById(replacedInput.bindingId);
      assert.isNull(closedBeforeWinner?.replacedByBindingId);
      const replacementWinnerInput = bindingInput({
        bindingId: "binding-replay-replacement-winner",
        coordinatorThreadId: "coordinator-replay-replace",
        architectThreadId: "arch:replay-replacement-winner",
        createIdempotencyKey: "replace-winner-create-key",
      });
      const committedWinner = yield* repository.createOrGetBinding(replacementWinnerInput);
      const linkedReplacement = yield* repository.linkReplacementWinner({
        replacedBindingId: replacedInput.bindingId,
        closeIdempotencyKey: "replace-replay-key",
        closeRequestFingerprint: "replace-replay-fingerprint",
        winnerBindingId: committedWinner.binding.bindingId,
      });
      assert.strictEqual(linkedReplacement?.replacedByBindingId, replacementWinnerInput.bindingId);
      const replaceReplay = yield* repository.findReplaceReplay({
        coordinatorThreadId: "coordinator-replay-replace",
        closeIdempotencyKey: "replace-replay-key",
        closeRequestFingerprint: "replace-replay-fingerprint",
      });
      assert.strictEqual(replaceReplay?.bindingId, replacedInput.bindingId);
      assert.strictEqual(replaceReplay?.replacedByBindingId, "binding-replay-replacement-winner");
      assert.deepEqual(replaceReplay?.routingEvidence, routingEvidence);
    }),
  );
});

it.effect(
  "elects exactly one binding under N-way separate-connection concurrency",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-architect-race-"));
      const dbPath = NodePath.join(tempDir, "state.sqlite");
      // Separate connections (separate layers) to the same temp-file DB.
      // `:memory:` cannot demonstrate cross-connection conflict.
      const connectionLayer = () =>
        CoordinatorArchitectRepositoryLive.pipe(
          Layer.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
        );
      // Initialize the schema once up front so the race measures the
      // binding election, not eight parallel migration runs.
      yield* Effect.scoped(
        Effect.provide(
          Effect.flatMap(CoordinatorArchitectRepository, (repository) =>
            repository.getActiveBindingByCoordinator("init"),
          ),
          connectionLayer(),
        ),
      );
      const creator = (index: number) =>
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(CoordinatorArchitectRepository, (repository) =>
              repository.createOrGetBinding(
                bindingInput({
                  bindingId: `binding-race-${index}`,
                  architectThreadId: `arch:race-${index}`,
                  createIdempotencyKey: `race-key-${index}`,
                  createRequestFingerprint: `race-fp-${index}`,
                }),
              ),
            ),
            connectionLayer(),
          ),
        );
      const results = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        creator,
        { concurrency: 8 },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
      const bindingIds = new Set(results.map((result) => result.binding.bindingId));
      assert.strictEqual(bindingIds.size, 1);
      assert.strictEqual(results.filter((result) => result.created).length, 1);
    }),
  60_000,
);

it.effect(
  "elects and links one parallel replacement across separate SQLite connections",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-architect-replace-race-"),
      );
      const dbPath = NodePath.join(tempDir, "state.sqlite");
      const connectionLayer = () =>
        CoordinatorArchitectRepositoryLive.pipe(
          Layer.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
        );
      const outcome = Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.provide(
            Effect.flatMap(CoordinatorArchitectRepository, (repository) =>
              repository.createOrGetBinding(
                bindingInput({
                  bindingId: "binding-before-parallel-replace",
                  coordinatorThreadId: "coordinator-parallel-replace",
                  architectThreadId: "arch:before-parallel-replace",
                  createIdempotencyKey: "before-parallel-replace",
                  createRequestFingerprint: "before-parallel-replace-fingerprint",
                }),
              ),
            ),
            connectionLayer(),
          ),
        );
        const replace = (index: number) =>
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const repository = yield* CoordinatorArchitectRepository;
                const closed = yield* repository.closeBinding({
                  bindingId: "binding-before-parallel-replace",
                  status: "replaced",
                  replacedByBindingId: null,
                  detachReason: "parallel replacement",
                  idempotencyKey: "parallel-replacement-key",
                  closeRequestFingerprint: "parallel-replacement-fingerprint",
                });
                assert.isNotNull(closed);
                const created = yield* repository.createOrGetBinding(
                  bindingInput({
                    bindingId: `binding-parallel-replacement-${index}`,
                    coordinatorThreadId: "coordinator-parallel-replace",
                    architectThreadId: `arch:parallel-replacement-${index}`,
                    createIdempotencyKey: "parallel-replacement-key",
                    createRequestFingerprint: "parallel-replacement-create-fingerprint",
                  }),
                );
                const linked = yield* repository.linkReplacementWinner({
                  replacedBindingId: "binding-before-parallel-replace",
                  closeIdempotencyKey: "parallel-replacement-key",
                  closeRequestFingerprint: "parallel-replacement-fingerprint",
                  winnerBindingId: created.binding.bindingId,
                });
                assert.strictEqual(linked?.replacedByBindingId, created.binding.bindingId);
                return { created: created.created, bindingId: created.binding.bindingId };
              }),
              connectionLayer(),
            ),
          );
        const outcomes = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          replace,
          { concurrency: 8 },
        );
        assert.strictEqual(new Set(outcomes.map((entry) => entry.bindingId)).size, 1);
        assert.strictEqual(outcomes.filter((entry) => entry.created).length, 1);
        yield* Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const repository = yield* CoordinatorArchitectRepository;
              const bindings = yield* repository.listBindingsByCoordinator(
                "coordinator-parallel-replace",
              );
              assert.strictEqual(
                bindings.filter((binding) => binding.status === "active").length,
                1,
              );
              assert.strictEqual(bindings.length, 2);
              assert.strictEqual(
                bindings.find((binding) => binding.status === "replaced")?.replacedByBindingId,
                outcomes[0]?.bindingId,
              );
              const replay = yield* repository.findReplaceReplay({
                coordinatorThreadId: "coordinator-parallel-replace",
                closeIdempotencyKey: "parallel-replacement-key",
                closeRequestFingerprint: "parallel-replacement-fingerprint",
              });
              assert.strictEqual(replay?.replacedByBindingId, outcomes[0]?.bindingId);
            }),
            connectionLayer(),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
      yield* outcome;
    }),
  60_000,
);
