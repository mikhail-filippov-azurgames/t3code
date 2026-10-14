import {
  ARCHITECT_BOUND_ACTIVITY,
  ARCHITECT_UNBOUND_ACTIVITY,
  COORDINATOR_ARCHITECT_ACTIVITY_KINDS,
  REVIEW_ANSWERED_ACTIVITY,
  REVIEW_CANCELLED_ACTIVITY,
  REVIEW_PUBLISHED_ACTIVITY,
  REVIEW_REQUESTED_ACTIVITY,
  REVIEW_REQUESTED_REF_ACTIVITY,
  hasPublishWakeDelivered,
  hasReviewWakeDelivered,
  needsPublishWakeReplay,
  needsReviewWakeReplay,
  publishWakeMessageId,
  publishWakeTurnCommandId,
  reviewRefCommandId,
  reviewWakeMessageId,
  reviewWakeTurnCommandId,
} from "../../../orchestration/coordinatorArchitect.ts";
import {
  ArchitectureReviewRefs,
  CommandId,
  EventId,
  MessageId,
  OrchestratorMcpFailure,
  ThreadId,
  type AgentRunOrigin,
  type ArchitectureReviewPublishedBy,
  type ArchitectureReviewRecord,
  type CoordinatorArchitectBinding,
  type CoordinatorArchitectRoutingEvidence,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestratorMcpArchitectCreateOrGetInput,
  type OrchestratorMcpArchitectCreateOrGetResult,
  type OrchestratorMcpArchitectDetachResult,
  type OrchestratorMcpArchitectReplaceResult,
  type OrchestratorMcpFailureCode,
  type OrchestratorMcpProviderCapability,
  type OrchestratorMcpGetCoordinatorBindingResult,
  type OrchestratorMcpListArchitectureReviewsResult,
  type OrchestratorMcpPrepareCoordinatorPublicationResult,
  type OrchestratorMcpPublishToCoordinatorResult,
  type OrchestratorMcpReviewAnswerResult,
  type OrchestratorMcpReviewCancelResult,
  type OrchestratorMcpReviewRequestResult,
  type ProviderInstanceConfigMap,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CoordinatorArchitectRepositoryShape } from "../../../persistence/Services/CoordinatorArchitect.ts";
import { deriveProviderInstanceConfigMap } from "../../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { applyAuthorTextPolicy, type AuthorTextField } from "../../../security/SecretTextPolicy.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import type { OrchestratorMcpDependencies, OrchestratorMcpServiceShape } from "./service.ts";

type ControlPlaneCaller =
  | { readonly kind: "architect"; readonly binding: CoordinatorArchitectBinding }
  | { readonly kind: "other" };

interface TargetParentContext {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly scope: NonNullable<McpInvocationScope["orchestration"]>;
}

interface ParentContext extends TargetParentContext {
  readonly activeTurnId: TurnId;
}

type ArchitectRuntimeDependencies = Pick<
  OrchestratorMcpDependencies,
  | "dispatch"
  | "getThreadDetailById"
  | "getProviders"
  | "getSettings"
  | "getShellSnapshot"
  | "coordinatorArchitect"
  | "getArchitectCreateReceiptStatus"
>;

type ArchitectServiceShape = Pick<
  OrchestratorMcpServiceShape,
  | "architectCreateOrGet"
  | "architectReplace"
  | "architectDetach"
  | "architectureReviewRequest"
  | "architectureReviewAnswer"
  | "architectureReviewCancel"
  | "prepareCoordinatorPublication"
  | "publishToCoordinator"
  | "publishArchitectPublication"
  | "getCoordinatorBinding"
  | "listArchitectureReviews"
  | "reconcileAfterRestart"
>;

interface ArchitectServiceDependencies {
  readonly dependencies: ArchitectRuntimeDependencies;
  readonly requireCapability: (
    scope: McpInvocationScope,
  ) => Effect.Effect<NonNullable<McpInvocationScope["orchestration"]>, OrchestratorMcpFailure>;
  readonly requireSplitEnabled: () => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly dispatchWakeTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnCommandId: string;
    readonly messageId: string;
    readonly fallbackTurnCommandId?: string;
    readonly fallbackMessageId?: string;
    readonly text: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: OrchestrationThreadShell["runtimeMode"];
    readonly interactionMode: OrchestrationThreadShell["interactionMode"];
    readonly createdAt: string;
    readonly runOrigin: Extract<
      AgentRunOrigin,
      { readonly _tag: "architect-review-request-wake" | "coordinator-publication-wake" }
    >;
  }) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly revokeArchitectCredential: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly revoked: boolean; readonly attempts: number }, never>;
  readonly resolveControlPlaneCaller: (
    scope: McpInvocationScope,
  ) => Effect.Effect<ControlPlaneCaller, OrchestratorMcpFailure>;
  readonly denyArchitectCaller: (
    caller: ControlPlaneCaller,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly denyExecutorCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly requireActiveParent: (
    scope: McpInvocationScope,
  ) => Effect.Effect<ParentContext, OrchestratorMcpFailure>;
  readonly loadSwitchParent: (
    scope: McpInvocationScope,
  ) => Effect.Effect<TargetParentContext, OrchestratorMcpFailure>;
  readonly loadThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, OrchestratorMcpFailure>;
  readonly loadThreadDetail: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, OrchestratorMcpFailure>;
  readonly requireRegisteredOrchestratorWhenBoardPresent: (
    scope: McpInvocationScope,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly ensureAuthorTextAllowed: (
    field: AuthorTextField,
    text: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly nowIso: () => Effect.Effect<string>;
  readonly failure: (code: OrchestratorMcpFailureCode, message: string) => OrchestratorMcpFailure;
  readonly mapStoreError: (operation: string) => (error: unknown) => OrchestratorMcpFailure;
  readonly orchestrationFailure: (operation: string) => (error: unknown) => OrchestratorMcpFailure;
  readonly errorMessage: (error: unknown) => string;
  readonly hash: (value: unknown) => string;
  readonly deterministicId: (prefix: string, ...parts: ReadonlyArray<string>) => string;
  readonly validateOptions: (
    selections: ReadonlyArray<ProviderOptionSelection>,
    descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  ) => ReadonlyArray<string>;
  readonly providerUnavailableReason: (provider: ServerProvider) => string | null;
  readonly providerCapability: (
    scope: McpInvocationScope,
    parent: ParentContext,
    providerInstances: ProviderInstanceConfigMap,
    provider: ServerProvider,
    mode?: {
      readonly runtimeMode?: OrchestrationThreadShell["runtimeMode"];
      readonly interactionMode?: OrchestrationThreadShell["interactionMode"];
      readonly t3McpCapabilities?: ReadonlySet<string>;
    },
  ) => Effect.Effect<OrchestratorMcpProviderCapability, OrchestratorMcpFailure>;
  readonly publishFailureReasonToken: (error: unknown) => string;
}

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

function rejectedAuthorTextField(field: AuthorTextField, text: string): AuthorTextField | null {
  try {
    return applyAuthorTextPolicy(field, text)._tag === "Accepted" ? null : field;
  } catch {
    // A failed check must reject authored text just like a detected secret.
    return field;
  }
}

export function makeArchitectService(input: ArchitectServiceDependencies): ArchitectServiceShape {
  const {
    dependencies,
    requireCapability,
    requireSplitEnabled,
    dispatchWakeTurn,
    revokeArchitectCredential,
    resolveControlPlaneCaller,
    denyArchitectCaller,
    denyExecutorCaller,
    requireActiveParent,
    loadSwitchParent,
    loadThreadShell,
    loadThreadDetail,
    requireRegisteredOrchestratorWhenBoardPresent,
    ensureAuthorTextAllowed,
    nowIso,
    failure,
    mapStoreError,
    orchestrationFailure,
    errorMessage,
    hash,
    deterministicId,
    validateOptions,
    providerUnavailableReason,
    providerCapability,
    publishFailureReasonToken,
  } = input;
  const reviewRefsJson = Schema.encodeSync(Schema.fromJsonString(ArchitectureReviewRefs));

  const loadArchitectActivityDetail = (threadId: ThreadId) =>
    dependencies
      .getThreadDetailById(threadId, {
        activityKinds: [...COORDINATOR_ARCHITECT_ACTIVITY_KINDS],
        activityHistory: "complete",
      })
      .pipe(Effect.mapError(orchestrationFailure(`read architect activity history ${threadId}`)));

  const requireArchitectStore = (): Effect.Effect<
    CoordinatorArchitectRepositoryShape,
    OrchestratorMcpFailure
  > =>
    dependencies.coordinatorArchitect === undefined
      ? Effect.fail(
          failure(
            "orchestration_error",
            "The coordinator/architect store is unavailable in this server composition.",
          ),
        )
      : Effect.succeed(dependencies.coordinatorArchitect);

  const validateArchitectSelection = Effect.fn("OrchestratorMcpService.validateArchitectSelection")(
    function* (input: {
      readonly scope: McpInvocationScope;
      readonly parent: ParentContext;
      readonly taskEffort: OrchestratorMcpArchitectCreateOrGetInput["taskEffort"];
      readonly modelSelection: ModelSelection;
      readonly routingEvidence: CoordinatorArchitectRoutingEvidence;
    }) {
      const evidence = input.routingEvidence;
      const selected = evidence.consideredCandidates[evidence.consideredCandidates.length - 1];
      if (
        evidence.role !== "architecture" ||
        evidence.taskEffort !== input.taskEffort ||
        selected === undefined ||
        selected.disposition !== "selected" ||
        selected.providerInstanceId !== input.modelSelection.instanceId ||
        selected.model !== input.modelSelection.model ||
        hash(selected.options) !== hash(input.modelSelection.options ?? [])
      ) {
        return yield* failure(
          "routing_evidence_mismatch",
          "The selected model does not match the accepted architecture routing evidence.",
        );
      }
      const providers = yield* dependencies.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );
      if (provider === undefined || provider.driver !== selected.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Selected architecture provider ${input.modelSelection.instanceId} is not live under the recorded driver.`,
        );
      }
      const unavailable = providerUnavailableReason(provider);
      if (unavailable !== null) return yield* failure("provider_unavailable", unavailable);
      const model = provider.models.find(
        (candidate) => candidate.slug === input.modelSelection.model,
      );
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Selected architecture model ${input.modelSelection.model} is not in the live provider catalog.`,
        );
      }
      const invalidOptions = validateOptions(
        input.modelSelection.options ?? [],
        model.capabilities?.optionDescriptors,
      );
      if (invalidOptions.length > 0) {
        return yield* failure("invalid_model_options", invalidOptions.join(" "));
      }
      const settings = yield* dependencies.getSettings;
      const permission = yield* providerCapability(
        input.scope,
        input.parent,
        deriveProviderInstanceConfigMap(settings),
        provider,
        {
          interactionMode: "plan",
          t3McpCapabilities: new Set(["orchestration"]),
        },
      );
      if (!permission.delegatable) {
        return yield* failure(
          permission.permissionEnvelope.status === "unverifiable"
            ? "permission_envelope_unverifiable"
            : "permission_escalation_denied",
          permission.unavailableReason ??
            "The selected architecture provider is not read-only eligible.",
        );
      }
      return input.modelSelection;
    },
  );

  const checkCoordinatorIdentity = (
    scope: McpInvocationScope,
    coordinatorThreadId: ThreadId,
    thread: OrchestrationThreadShell,
    operation: string,
  ): Effect.Effect<ControlPlaneCaller, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const caller = yield* resolveControlPlaneCaller(scope);
      yield* denyArchitectCaller(caller, operation);
      if (scope.threadId !== coordinatorThreadId) {
        return yield* failure(
          "capability_denied",
          "Only the coordinator thread itself (or a human on it) may perform this operation.",
        );
      }
      if (thread.delegationParent !== null && thread.delegationParent !== undefined) {
        // Delegated executors may not act as coordinators on any lineage.
        return yield* failure(
          "delegated_executor_denied",
          "Delegated executor threads cannot perform coordinator control-plane operations.",
        );
      }
      return caller;
    });

  const appendPhase1Activity = (input: {
    readonly threadId: ThreadId;
    readonly commandId: string;
    readonly fallbackCommandId?: string;
    readonly activityId: string;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const detail = yield* loadThreadDetail(input.threadId);
      if (
        Option.isSome(detail) &&
        detail.value.activities.some((activity) => activity.id === input.activityId)
      ) {
        return;
      }
      const dispatchActivity = (commandId: string) =>
        dependencies.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(commandId),
          threadId: input.threadId,
          activity: {
            id: EventId.make(input.activityId),
            tone: "info",
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
      yield* dispatchActivity(input.commandId).pipe(
        Effect.catchTag("OrchestrationCommandIdConflictError", (error) =>
          input.fallbackCommandId !== undefined &&
          error.receiptAggregateKind === "thread" &&
          error.receiptAggregateId !== input.threadId &&
          error.commandAggregateKind === "thread" &&
          error.commandAggregateId === input.threadId
            ? dispatchActivity(input.fallbackCommandId)
            : Effect.fail(error),
        ),
        Effect.mapError(orchestrationFailure("append coordinator/architect activity")),
      );
    });

  const softDeleteArchitectThread = (
    threadId: ThreadId,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const shell = yield* loadThreadShell(threadId);
      // The ordinary shell query already excludes deleted threads; if the
      // shell is absent there is nothing left to delete.
      if (Option.isNone(shell)) return;
      yield* dependencies
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`architect-delete:${threadId}`),
          threadId,
        })
        .pipe(
          Effect.catchTags({ OrchestrationCommandIdConflictError: () => Effect.void }),
          Effect.mapError((error) =>
            isOrchestratorMcpFailure(error)
              ? error
              : orchestrationFailure("soft-delete architect thread")(error),
          ),
        );
    });

  const createArchitectThread = (
    binding: CoordinatorArchitectBinding,
    coordinator: OrchestrationThreadShell,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const evidence = binding.routingEvidence;
      const selected = evidence?.consideredCandidates.at(-1);
      if (selected === undefined || selected.disposition !== "selected") {
        return yield* failure(
          "routing_evidence_mismatch",
          "The active Architect binding has no selected routing evidence for deterministic recovery.",
        );
      }
      const modelSelection: ModelSelection = {
        instanceId: selected.providerInstanceId,
        model: selected.model,
        options: selected.options,
      };
      yield* dependencies
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`architect-create:${binding.bindingId}`),
          threadId: binding.architectThreadId,
          projectId: binding.projectId,
          title: "Architect",
          modelSelection,
          runtimeMode: coordinator.runtimeMode,
          // The architect never runs in plan mode: in plan it cannot use
          // its own MCP surface, and any later plan/default toggle would
          // invalidate its frozen credential at the drift gate below.
          interactionMode: "default",
          branch: coordinator.branch,
          worktreePath: coordinator.worktreePath,
          createdAt: binding.createdAt,
        })
        .pipe(
          Effect.catchTags({
            OrchestrationCommandIdConflictError: () => Effect.void,
            OrchestrationCommandInvariantError: (error) =>
              Effect.fail(
                failure(
                  "idempotency_conflict",
                  `The deterministic Architect create command conflicts with an existing thread: ${errorMessage(error)}`,
                ),
              ),
            OrchestrationCommandPreviouslyRejectedError: (error) =>
              Effect.fail(orchestrationFailure("create architect thread")(error)),
          }),
          Effect.mapError((error) =>
            isOrchestratorMcpFailure(error)
              ? error
              : orchestrationFailure("create architect thread")(error),
          ),
        );
    });

  const wakeArchitectForReview = (
    review: ArchitectureReviewRecord,
    binding: CoordinatorArchitectBinding,
    at: string,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const detailOption = yield* loadArchitectActivityDetail(binding.architectThreadId);
      if (Option.isNone(detailOption)) {
        return yield* failure(
          "orchestration_error",
          "The bound architect thread no longer exists.",
        );
      }
      if (
        hasReviewWakeDelivered(
          detailOption.value.activities,
          binding.architectThreadId,
          review.reviewId,
        )
      ) {
        return;
      }
      const shellOption = yield* loadThreadShell(binding.architectThreadId);
      if (Option.isNone(shellOption)) {
        return yield* failure(
          "orchestration_error",
          "The bound architect thread no longer exists.",
        );
      }
      const shell = shellOption.value;
      yield* dispatchWakeTurn({
        threadId: binding.architectThreadId,
        runOrigin: { _tag: "architect-review-request-wake" },
        turnCommandId: reviewWakeTurnCommandId(review.reviewId),
        messageId: reviewWakeMessageId(review.reviewId),
        fallbackTurnCommandId: `arch:review-wake-turn:${binding.architectThreadId}:${review.reviewId}`,
        fallbackMessageId: `arch:review-wake:${binding.architectThreadId}:${review.reviewId}`,
        text: `Architecture review requested (${review.reason}; execution posture: ${review.executionPosture}):\n${review.question}\n\nAnswer this review by calling architecture_review_answer with reviewId ${review.reviewId}. An ordinary answer never wakes the Coordinator. Call publish_to_coordinator only if this answer should wake the Coordinator.`,
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: at,
      });
    });

  const wakeCoordinatorForPublish = (
    review: ArchitectureReviewRecord,
    binding: CoordinatorArchitectBinding,
    at: string,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const detailOption = yield* loadArchitectActivityDetail(binding.coordinatorThreadId);
      if (Option.isNone(detailOption)) {
        return yield* failure("orchestration_error", "The coordinator thread no longer exists.");
      }
      if (
        hasPublishWakeDelivered(
          detailOption.value.activities,
          binding.coordinatorThreadId,
          review.reviewId,
        )
      ) {
        return;
      }
      const shellOption = yield* loadThreadShell(binding.coordinatorThreadId);
      if (Option.isNone(shellOption)) {
        return yield* failure("orchestration_error", "The coordinator thread no longer exists.");
      }
      const shell = shellOption.value;
      const disposition = review.answerDisposition;
      if (disposition === null) {
        return yield* failure(
          "review_state_conflict",
          "An answered review must have a stored answer disposition before it can be published.",
        );
      }
      const summary = review.answerSummary ?? "";
      const refs = review.refs;
      const text =
        review.publishedBy === "human"
          ? `Published by the human via the Publish button\n${
              review.origin === "coordinator-request"
                ? `Coordinator question:\n${review.question}\n\n`
                : ""
            }Disposition: ${disposition}\nSummary: ${summary}\nStable references: ${reviewRefsJson(refs)}`
          : `Architecture review published [${disposition}]:\n${summary}\nStable references: ${reviewRefsJson(refs)}`;
      // The delivered marker is written by the provider reactor only after
      // `sendTurn` is confirmed, so a failed send cannot leave a marker here.
      yield* dispatchWakeTurn({
        threadId: binding.coordinatorThreadId,
        runOrigin: { _tag: "coordinator-publication-wake" },
        turnCommandId: publishWakeTurnCommandId(review.reviewId),
        messageId: publishWakeMessageId(review.reviewId),
        text,
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: at,
      });
    });

  const recordPublishFailure = (
    store: CoordinatorArchitectRepositoryShape,
    reviewId: string,
    attemptedAt: string,
    error: unknown,
  ) =>
    store
      .recordPublishFailure({
        reviewId,
        reason: publishFailureReasonToken(error),
        message: (isOrchestratorMcpFailure(error) ? error.message : errorMessage(error)).slice(
          0,
          2_000,
        ),
        attemptedAt,
      })
      .pipe(Effect.mapError(mapStoreError("record publish failure")), Effect.ignore);

  const refusePublish = (
    store: CoordinatorArchitectRepositoryShape,
    reviewId: string,
    attemptedAt: string,
    code: OrchestratorMcpFailureCode,
    message: string,
  ) =>
    Effect.gen(function* () {
      const error = failure(code, message);
      yield* recordPublishFailure(store, reviewId, attemptedAt, error);
      return yield* error;
    });

  const publishAnsweredReview = (
    store: CoordinatorArchitectRepositoryShape,
    review: ArchitectureReviewRecord,
    binding: CoordinatorArchitectBinding,
    input: {
      readonly idempotencyKey: string;
      readonly publishedBy: ArchitectureReviewPublishedBy;
      readonly publishedAt: string;
    },
  ) =>
    Effect.gen(function* () {
      const unsafeField =
        rejectedAuthorTextField("question", review.question) ??
        (review.answerSummary === null
          ? null
          : rejectedAuthorTextField("summary", review.answerSummary));
      if (unsafeField !== null) {
        return yield* refusePublish(
          store,
          review.reviewId,
          input.publishedAt,
          "author_text_rejected",
          `The authored ${unsafeField} could not be confirmed secret-free. Remove sensitive values and try again.`,
        );
      }

      const transition = yield* store
        .publishReview({
          reviewId: review.reviewId,
          publishIdempotencyKey: input.idempotencyKey,
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        })
        .pipe(Effect.mapError(mapStoreError("publish architecture review")));
      if (transition._tag === "conflict") {
        return yield* refusePublish(
          store,
          review.reviewId,
          input.publishedAt,
          "idempotency_conflict",
          "This publish key was already used for this review.",
        );
      }
      if (transition._tag === "state") {
        return yield* refusePublish(
          store,
          review.reviewId,
          input.publishedAt,
          "review_state_conflict",
          "Only answered reviews can be published.",
        );
      }
      if (transition._tag === "unsafe_text") {
        return yield* refusePublish(
          store,
          review.reviewId,
          input.publishedAt,
          "author_text_rejected",
          "The stored review contains sensitive text and cannot be published. Remove sensitive values and try again.",
        );
      }

      const stored =
        (yield* store
          .getReviewById(review.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")))) ?? review;
      const deliver = Effect.gen(function* () {
        if (transition._tag === "applied" || transition._tag === "replay") {
          yield* appendPhase1Activity({
            threadId: binding.coordinatorThreadId,
            commandId: `arch:review-published:${review.reviewId}`,
            activityId: `arch:review-published:${review.reviewId}`,
            kind: REVIEW_PUBLISHED_ACTIVITY,
            summary: "Architecture review published",
            payload: {
              reviewId: stored.reviewId,
              disposition: stored.answerDisposition,
              summary: stored.answerSummary,
              refs: stored.refs,
              publishedBy: stored.publishedBy,
            },
            createdAt: input.publishedAt,
          });
        }
        yield* wakeCoordinatorForPublish(stored, binding, input.publishedAt);
      }).pipe(
        Effect.tapError((error) =>
          recordPublishFailure(store, review.reviewId, input.publishedAt, error),
        ),
      );
      yield* deliver;
      return {
        reviewId: review.reviewId,
        status: "published",
      } satisfies OrchestratorMcpPublishToCoordinatorResult;
    });

  const service: ArchitectServiceShape = {
    architectCreateOrGet: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "create an architect");
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "create an architect");
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "create an architect",
        );
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const activeBeforeCreate = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (activeBeforeCreate === null) {
          yield* validateArchitectSelection({
            scope,
            parent,
            taskEffort: input.taskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: input.routingEvidence,
          });
        }
        const bindingId = deterministicId(
          "architect-binding",
          coordinatorThreadId,
          input.idempotencyKey,
        );
        // Deterministic `arch:`-derived identity: stable for exact retry,
        // fresh across keys. Losers (created:false) never dispatch create,
        // so concurrent same-target creates converge to exactly one thread.
        const architectThreadId = ThreadId.make(
          `arch:${hash(["architect-thread", coordinatorThreadId, input.idempotencyKey]).slice(0, 40)}`,
        );
        const outcome = yield* store
          .createOrGetBinding({
            bindingId,
            coordinatorThreadId,
            architectThreadId,
            projectId: parent.thread.projectId,
            architectTaskEffort: input.taskEffort,
            routingEvidence: input.routingEvidence,
            createdAt: at,
            createdBy: scope.threadId,
            createIdempotencyKey: input.idempotencyKey,
            createRequestFingerprint: hash({
              taskEffort: input.taskEffort,
              modelSelection: input.modelSelection,
              routingEvidence: input.routingEvidence,
            }),
          })
          .pipe(Effect.mapError(mapStoreError("create architect binding")));
        const binding = outcome.binding;
        if (binding.status !== "active") {
          return yield* failure(
            "binding_not_found",
            "This Architect binding is terminal and cannot be recreated by replaying its create key.",
          );
        }
        const exactCreateReplay = binding.createIdempotencyKey === input.idempotencyKey;
        if (!outcome.created && !exactCreateReplay) {
          return {
            architectThreadId: binding.architectThreadId,
            created: false,
            binding,
          } satisfies OrchestratorMcpArchitectCreateOrGetResult;
        }
        const existingThread = yield* loadThreadShell(binding.architectThreadId);
        if (Option.isNone(existingThread)) {
          yield* createArchitectThread(binding, parent.thread);
        }
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-bound:${binding.bindingId}`,
          activityId: `architect-bound:${binding.bindingId}`,
          kind: ARCHITECT_BOUND_ACTIVITY,
          summary: "Architect bound",
          payload: {
            bindingId: binding.bindingId,
            coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            architectTaskEffort: binding.architectTaskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: binding.routingEvidence,
          },
          createdAt: at,
        });
        return {
          architectThreadId: binding.architectThreadId,
          created: outcome.created,
          binding,
        } satisfies OrchestratorMcpArchitectCreateOrGetResult;
      }),
    architectReplace: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "replace the architect");
        yield* denyArchitectCaller(
          yield* resolveControlPlaneCaller(scope),
          "replace the architect",
        );
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "replace the architect",
        );
        yield* ensureAuthorTextAllowed("reason", input.reason);
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const newBindingId = deterministicId(
          "architect-binding",
          coordinatorThreadId,
          input.idempotencyKey,
        );
        const newArchitectThreadId = ThreadId.make(
          `arch:${hash(["architect-thread", newBindingId]).slice(0, 40)}`,
        );
        const taskEffort = input.taskEffort;
        const closeRequestFingerprint = hash({
          operation: "replace",
          reason: input.reason,
          taskEffort,
          modelSelection: input.modelSelection,
          routingEvidence: input.routingEvidence,
          replacedByBindingId: newBindingId,
        });
        const createRequestFingerprint = hash({
          taskEffort,
          modelSelection: input.modelSelection,
          routingEvidence: input.routingEvidence,
        });
        const createInput = {
          bindingId: newBindingId,
          coordinatorThreadId,
          architectThreadId: newArchitectThreadId,
          projectId: parent.thread.projectId,
          architectTaskEffort: taskEffort,
          routingEvidence: input.routingEvidence,
          createdAt: at,
          createdBy: scope.threadId,
          createIdempotencyKey: input.idempotencyKey,
          createRequestFingerprint,
        } as const;

        const priorReplacement = yield* store
          .findBindingByCreateKey({
            coordinatorThreadId,
            createIdempotencyKey: input.idempotencyKey,
          })
          .pipe(Effect.mapError(mapStoreError("read architect replacement")));
        if (priorReplacement !== null) {
          // Re-enter the repository's exact fingerprint check before returning
          // a same-key replay. This also closes the crash gap after insert.
          yield* store
            .createOrGetBinding(createInput)
            .pipe(Effect.mapError(mapStoreError("replay architect replacement")));
          if (priorReplacement.status === "active") {
            const existingThread = yield* loadThreadShell(priorReplacement.architectThreadId);
            if (Option.isNone(existingThread)) {
              yield* createArchitectThread(priorReplacement, parent.thread);
            }
            const replaced = yield* store
              .findReplaceReplay({
                coordinatorThreadId,
                closeIdempotencyKey: input.idempotencyKey,
                closeRequestFingerprint,
              })
              .pipe(Effect.mapError(mapStoreError("read replaced architect binding")));
            if (replaced !== null) {
              const linked = yield* store
                .linkReplacementWinner({
                  replacedBindingId: replaced.bindingId,
                  closeIdempotencyKey: input.idempotencyKey,
                  closeRequestFingerprint,
                  winnerBindingId: priorReplacement.bindingId,
                })
                .pipe(Effect.mapError(mapStoreError("link replacement winner")));
              if (linked === null) {
                return yield* failure(
                  "binding_conflict",
                  "The committed replacement could not be linked to its prior binding.",
                );
              }
              const receipt = yield* revokeArchitectCredential(replaced.architectThreadId);
              yield* appendPhase1Activity({
                threadId: coordinatorThreadId,
                commandId: `architect-unbound:${replaced.bindingId}`,
                activityId: `architect-unbound:${replaced.bindingId}`,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect replaced",
                payload: {
                  bindingId: replaced.bindingId,
                  architectThreadId: replaced.architectThreadId,
                  reason: input.reason,
                  replacedByBindingId: linked.replacedByBindingId,
                  revokeReceipt: receipt,
                },
                createdAt: at,
              });
              yield* softDeleteArchitectThread(replaced.architectThreadId);
            }
            yield* appendPhase1Activity({
              threadId: coordinatorThreadId,
              commandId: `architect-bound:${priorReplacement.bindingId}`,
              activityId: `architect-bound:${priorReplacement.bindingId}`,
              kind: ARCHITECT_BOUND_ACTIVITY,
              summary: "Architect bound",
              payload: {
                bindingId: priorReplacement.bindingId,
                coordinatorThreadId,
                architectThreadId: priorReplacement.architectThreadId,
                architectTaskEffort: priorReplacement.architectTaskEffort,
                modelSelection: input.modelSelection,
                routingEvidence: priorReplacement.routingEvidence,
              },
              createdAt: at,
            });
          }
          return {
            architectThreadId: priorReplacement.architectThreadId,
            binding: priorReplacement,
          } satisfies OrchestratorMcpArchitectReplaceResult;
        }

        const active = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        let closed: CoordinatorArchitectBinding | null;
        if (active !== null) {
          yield* validateArchitectSelection({
            scope,
            parent,
            taskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: input.routingEvidence,
          });
          closed = yield* store
            .closeBinding({
              bindingId: active.bindingId,
              status: "replaced",
              // The replacement row is not committed yet. Link only after
              // deterministic winner election commits its binding row.
              replacedByBindingId: null,
              detachReason: input.reason,
              idempotencyKey: input.idempotencyKey,
              closeRequestFingerprint,
            })
            .pipe(Effect.mapError(mapStoreError("close architect binding")));
          if (closed === null) {
            const winner = yield* store
              .getActiveBindingByCoordinator(coordinatorThreadId)
              .pipe(Effect.mapError(mapStoreError("resolve architect replacement race")));
            if (winner !== null) {
              return {
                architectThreadId: winner.architectThreadId,
                binding: winner,
              } satisfies OrchestratorMcpArchitectReplaceResult;
            }
            return yield* failure(
              "binding_conflict",
              "Another replacement committed the close; retry after its winner is visible.",
            );
          }
        } else {
          // Recover the committed close-before-create window without reviving
          // an unrelated terminal binding or accepting changed request data.
          closed = yield* store
            .findReplaceReplay({
              coordinatorThreadId,
              closeIdempotencyKey: input.idempotencyKey,
              closeRequestFingerprint,
            })
            .pipe(Effect.mapError(mapStoreError("recover architect replacement")));
          if (closed === null) {
            const winner = yield* store
              .getActiveBindingByCoordinator(coordinatorThreadId)
              .pipe(Effect.mapError(mapStoreError("resolve architect replacement race")));
            if (winner !== null) {
              return {
                architectThreadId: winner.architectThreadId,
                binding: winner,
              } satisfies OrchestratorMcpArchitectReplaceResult;
            }
            return yield* failure(
              "binding_not_found",
              "No active Architect or exact interrupted replacement exists for this coordinator.",
            );
          }
        }
        // Ordered boundary step (1): the durable active→replaced transition
        // commits before any thread or credential work.
        const created = yield* store
          .createOrGetBinding(createInput)
          .pipe(Effect.mapError(mapStoreError("create architect binding")));
        const linked = yield* store
          .linkReplacementWinner({
            replacedBindingId: closed.bindingId,
            closeIdempotencyKey: input.idempotencyKey,
            closeRequestFingerprint,
            winnerBindingId: created.binding.bindingId,
          })
          .pipe(Effect.mapError(mapStoreError("link replacement winner")));
        if (linked === null) {
          return yield* failure(
            "binding_conflict",
            "The committed replacement could not be linked to its prior binding.",
          );
        }
        if (created.binding.bindingId !== newBindingId) {
          // Lost the replace race: our thread.create never ran (binding-first
          // ordering), so converge on the winner. If our deterministic thread
          // id somehow exists (same-key replay after a crash), audit it as a
          // race loser rather than leaking a binding-less architect thread.
          const winner = created.binding;
          const oursOption = yield* loadThreadDetail(newArchitectThreadId);
          if (
            Option.isSome(oursOption) &&
            oursOption.value.id === newArchitectThreadId &&
            winner.architectThreadId !== newArchitectThreadId
          ) {
            const receipt = yield* revokeArchitectCredential(newArchitectThreadId);
            yield* appendPhase1Activity({
              threadId: coordinatorThreadId,
              commandId: `architect-unbound-race:${newBindingId}`,
              activityId: `architect-unbound-race:${newBindingId}`,
              kind: ARCHITECT_UNBOUND_ACTIVITY,
              summary: "Architect race loser soft-deleted",
              payload: {
                bindingId: newBindingId,
                architectThreadId: newArchitectThreadId,
                reason: "binding-race-lost",
                revokeReceipt: receipt,
              },
              createdAt: at,
            });
            yield* softDeleteArchitectThread(newArchitectThreadId);
          }
          return {
            architectThreadId: winner.architectThreadId,
            binding: winner,
          } satisfies OrchestratorMcpArchitectReplaceResult;
        }
        const binding = created.binding;
        yield* createArchitectThread(binding, parent.thread);
        const receipt = yield* revokeArchitectCredential(closed.architectThreadId);
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-unbound:${closed.bindingId}`,
          activityId: `architect-unbound:${closed.bindingId}`,
          kind: ARCHITECT_UNBOUND_ACTIVITY,
          summary: "Architect replaced",
          payload: {
            bindingId: closed.bindingId,
            architectThreadId: closed.architectThreadId,
            reason: input.reason,
            replacedByBindingId: linked.replacedByBindingId,
            revokeReceipt: receipt,
          },
          createdAt: at,
        });
        yield* softDeleteArchitectThread(closed.architectThreadId);
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-bound:${binding.bindingId}`,
          activityId: `architect-bound:${binding.bindingId}`,
          kind: ARCHITECT_BOUND_ACTIVITY,
          summary: "Architect bound",
          payload: {
            bindingId: binding.bindingId,
            coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            architectTaskEffort: binding.architectTaskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: binding.routingEvidence,
          },
          createdAt: at,
        });
        return {
          architectThreadId: binding.architectThreadId,
          binding,
        } satisfies OrchestratorMcpArchitectReplaceResult;
      }),
    architectDetach: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "detach the architect");
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "detach the architect");
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "detach the architect",
        );
        yield* ensureAuthorTextAllowed("reason", input.reason);
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const active = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (active === null) {
          // Idempotent replay returns the same terminal binding via the
          // exact close key; terminal bindings never restore.
          const replayed = yield* store
            .findDetachReplay({
              coordinatorThreadId,
              closeIdempotencyKey: input.idempotencyKey,
              closeRequestFingerprint: hash({ operation: "detach", reason: input.reason }),
            })
            .pipe(Effect.mapError(mapStoreError("read architect binding")));
          if (replayed !== null) {
            return { binding: replayed } satisfies OrchestratorMcpArchitectDetachResult;
          }
          return yield* failure(
            "binding_not_found",
            "No active architect binding for this coordinator.",
          );
        }
        const closed = yield* store
          .closeBinding({
            bindingId: active.bindingId,
            status: "detached",
            replacedByBindingId: null,
            detachReason: input.reason,
            idempotencyKey: input.idempotencyKey,
            closeRequestFingerprint: hash({ operation: "detach", reason: input.reason }),
          })
          .pipe(Effect.mapError(mapStoreError("close architect binding")));
        if (closed === null || closed.status !== "detached") {
          return yield* failure(
            "binding_conflict",
            "The Architect binding changed during detach; read the current binding before retrying.",
          );
        }
        const receipt = yield* revokeArchitectCredential(active.architectThreadId);
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-unbound:${active.bindingId}`,
          activityId: `architect-unbound:${active.bindingId}`,
          kind: ARCHITECT_UNBOUND_ACTIVITY,
          summary: "Architect detached",
          payload: {
            bindingId: active.bindingId,
            architectThreadId: active.architectThreadId,
            reason: input.reason,
            replacedByBindingId: null,
            revokeReceipt: receipt,
          },
          createdAt: at,
        });
        yield* softDeleteArchitectThread(active.architectThreadId);
        return {
          binding: closed,
        } satisfies OrchestratorMcpArchitectDetachResult;
      }),
    architectureReviewRequest: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "request an architecture review");
        yield* denyArchitectCaller(
          yield* resolveControlPlaneCaller(scope),
          "request an architecture review",
        );
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "request an architecture review",
        );
        const posture = (input as { readonly executionPosture?: unknown }).executionPosture;
        if (posture !== "continue" && posture !== "pause-branch" && posture !== "pause-all") {
          // Schema requires executionPosture (no default); this is
          // defense-in-depth so a missing posture is a typed rejection with
          // no record created.
          return yield* failure(
            "orchestration_error",
            "A review request requires an explicit executionPosture: continue, pause-branch, or pause-all.",
          );
        }
        yield* ensureAuthorTextAllowed("question", input.question);
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const binding = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (binding === null) {
          return yield* failure(
            "binding_not_found",
            "No active architect binding for this coordinator.",
          );
        }
        const reviewId = deterministicId(
          "architecture-review",
          coordinatorThreadId,
          input.idempotencyKey,
        );
        const outcome = yield* store
          .insertReview({
            reviewId,
            bindingId: binding.bindingId,
            coordinatorThreadId: binding.coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            subjectChildThreadId: input.subjectChildThreadId ?? null,
            reason: input.reason,
            question: input.question,
            refs: input.refs ?? {},
            executionPosture: input.executionPosture,
            requestIdempotencyKey: input.idempotencyKey,
            requestPayloadFingerprint: hash({
              subjectChildThreadId: input.subjectChildThreadId ?? null,
              reason: input.reason,
              question: input.question,
              refs: input.refs ?? {},
              executionPosture: input.executionPosture,
            }),
            createdAt: at,
          })
          .pipe(Effect.mapError(mapStoreError("insert architecture review")));
        const review = outcome.review;
        yield* ensureAuthorTextAllowed("question", review.question);
        // Ordered intent first: architect aggregate carries the request,
        // coordinator aggregate carries only the typed no-wake reference.
        // Deterministic command ids also repair an exact retry after a crash
        // between the durable insert and either activity append.
        yield* appendPhase1Activity({
          threadId: binding.architectThreadId,
          commandId: `arch:review-requested:${reviewId}`,
          activityId: `arch:review-requested:${reviewId}`,
          kind: REVIEW_REQUESTED_ACTIVITY,
          summary: "Architecture review requested",
          payload: {
            reviewId,
            bindingId: binding.bindingId,
            reason: review.reason,
            question: review.question,
            refs: review.refs,
            executionPosture: review.executionPosture,
            subjectChildThreadId: review.subjectChildThreadId,
          },
          createdAt: at,
        });
        yield* appendPhase1Activity({
          threadId: binding.coordinatorThreadId,
          commandId: reviewRefCommandId(reviewId),
          activityId: reviewRefCommandId(reviewId),
          kind: REVIEW_REQUESTED_REF_ACTIVITY,
          summary: "Architecture review requested (no wake)",
          payload: {
            reviewId,
            bindingId: binding.bindingId,
            reason: review.reason,
            executionPosture: review.executionPosture,
          },
          createdAt: at,
        });
        // Marker-gated: exact replay and crash-gap recovery converge here.
        yield* wakeArchitectForReview(review, binding, at);
        return { reviewId, status: "open" } satisfies OrchestratorMcpReviewRequestResult;
      }),
    architectureReviewAnswer: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const disposition = (input as { readonly disposition?: unknown }).disposition;
        if (
          disposition !== "recommendation" &&
          disposition !== "needs-human-decision" &&
          disposition !== "needs-more-evidence"
        ) {
          return yield* failure(
            "orchestration_error",
            "An architecture answer requires an explicit disposition: recommendation, needs-human-decision, or needs-more-evidence.",
          );
        }
        const at = yield* nowIso();
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        // Architect-side only: the caller must hold the review's ACTIVE
        // binding. A stale pre-revoke credential finds no binding and fails
        // here even before registry revocation lands.
        const callerBinding = yield* store
          .getActiveBindingByArchitect(scope.threadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (callerBinding === null || callerBinding.bindingId !== review.bindingId) {
          return yield* failure(
            "architect_denied",
            "Only the bound architect thread may answer its own reviews.",
          );
        }
        yield* ensureAuthorTextAllowed("summary", input.summary);
        const fingerprint = hash({
          summary: input.summary,
          disposition: input.disposition,
          oclRefs: input.oclRefs ?? [],
        });
        const transition = yield* store
          .answerReview({
            reviewId: review.reviewId,
            disposition: input.disposition,
            summary: input.summary,
            oclRefs: [...(input.oclRefs ?? [])],
            answerIdempotencyKey: input.idempotencyKey,
            answerPayloadFingerprint: fingerprint,
            answeredAt: at,
          })
          .pipe(Effect.mapError(mapStoreError("answer architecture review")));
        if (transition._tag === "conflict") {
          return yield* failure(
            "idempotency_conflict",
            "This answer key already stored a different answer payload (summary, disposition, or refs).",
          );
        }
        if (transition._tag === "state") {
          return yield* failure(
            "review_state_conflict",
            "The review is no longer open for answering.",
          );
        }
        if (transition._tag === "applied" || transition._tag === "replay") {
          yield* appendPhase1Activity({
            threadId: review.architectThreadId,
            commandId: `arch:review-answered:${review.reviewId}`,
            activityId: `arch:review-answered:${review.reviewId}`,
            kind: REVIEW_ANSWERED_ACTIVITY,
            summary: "Architecture review answered",
            payload: {
              reviewId: review.reviewId,
              disposition: input.disposition,
              summary: input.summary,
              oclRefs: input.oclRefs ?? [],
            },
            createdAt: at,
          });
        }
        // NEVER wakes the coordinator (normative §7.3): no turn dispatch on
        // any answer path, regardless of disposition.
        const stored =
          transition._tag === "replay"
            ? ((yield* store
                .getReviewById(review.reviewId)
                .pipe(Effect.mapError(mapStoreError("read architecture review")))) ?? review)
            : review;
        return {
          reviewId: review.reviewId,
          status: "answered",
          disposition: stored.answerDisposition ?? input.disposition,
        } satisfies OrchestratorMcpReviewAnswerResult;
      }),
    architectureReviewCancel: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "cancel architecture reviews");
        if ((yield* resolveControlPlaneCaller(scope)).kind === "architect") {
          return yield* failure(
            "architect_denied",
            "Architect threads cannot cancel reviews; cancellation is coordinator/human only.",
          );
        }
        yield* requireRegisteredOrchestratorWhenBoardPresent(scope);
        const at = yield* nowIso();
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        // Coordinator/human only: architect cancel is denied even for its
        // own reviews; anyone else is out of scope.
        const caller = yield* resolveControlPlaneCaller(scope);
        if (caller.kind === "architect") {
          return yield* failure(
            "architect_denied",
            "Architect threads cannot cancel reviews; cancellation is coordinator/human only.",
          );
        }
        if (scope.threadId !== review.coordinatorThreadId) {
          return yield* failure(
            "capability_denied",
            "Only the coordinator thread itself (or a human on it) may cancel this review.",
          );
        }
        yield* ensureAuthorTextAllowed("reason", input.reason);
        const transition = yield* store
          .cancelReview({
            reviewId: review.reviewId,
            reason: input.reason,
            cancelIdempotencyKey: input.idempotencyKey,
            cancelPayloadFingerprint: hash({
              reason: input.reason,
              cancelledBy: scope.threadId,
            }),
            cancelledAt: at,
            cancelledBy: scope.threadId,
          })
          .pipe(Effect.mapError(mapStoreError("cancel architecture review")));
        if (transition._tag === "state") {
          return yield* failure(
            "review_state_conflict",
            "Only open or answered reviews can be cancelled.",
          );
        }
        if (transition._tag === "conflict") {
          return yield* failure(
            "idempotency_conflict",
            "This cancel key was already used with a different reason.",
          );
        }
        if (transition._tag === "applied" || transition._tag === "replay") {
          yield* appendPhase1Activity({
            threadId: review.coordinatorThreadId,
            commandId: `arch:review-cancelled:${review.reviewId}`,
            activityId: `arch:review-cancelled:${review.reviewId}`,
            kind: REVIEW_CANCELLED_ACTIVITY,
            summary: "Architecture review cancelled",
            payload: { reviewId: review.reviewId, reason: input.reason },
            createdAt: at,
          });
        }
        return {
          reviewId: review.reviewId,
          status: "cancelled",
        } satisfies OrchestratorMcpReviewCancelResult;
      }),
    prepareCoordinatorPublication: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const binding = yield* store
          .getActiveBindingByArchitect(scope.threadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (binding === null) {
          return yield* failure(
            "architect_denied",
            "Only an Architect with an active binding may prepare a coordinator publication.",
          );
        }
        yield* loadSwitchParent(scope);
        yield* ensureAuthorTextAllowed("summary", input.summary);
        const oclRefs = input.oclRefs ?? [];
        const preparedAt = yield* nowIso();
        const review = yield* store
          .upsertPreparedPublication({
            reviewId: deterministicId(
              "architecture-advice",
              binding.bindingId,
              input.idempotencyKey,
            ),
            bindingId: binding.bindingId,
            coordinatorThreadId: binding.coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            summary: input.summary,
            disposition: input.disposition,
            oclRefs,
            executionPosture: input.executionPosture,
            idempotencyKey: input.idempotencyKey,
            payloadFingerprint: hash({
              summary: input.summary,
              disposition: input.disposition,
              oclRefs,
              executionPosture: input.executionPosture,
            }),
            preparedAt,
          })
          .pipe(Effect.mapError(mapStoreError("prepare coordinator publication")));
        return {
          reviewId: review.reviewId,
          status: "answered",
        } satisfies OrchestratorMcpPrepareCoordinatorPublicationResult;
      }),
    publishToCoordinator: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "publish architecture reviews");
        // Fail forged architect claims before the review lookup so a hidden
        // tool always denies; coordinator registration keeps unmarked chats
        // from publishing.
        if ((yield* resolveControlPlaneCaller(scope)).kind !== "architect") {
          yield* requireRegisteredOrchestratorWhenBoardPresent(scope);
        }
        const at = yield* nowIso();
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        const caller = yield* resolveControlPlaneCaller(scope);
        const isOwnerArchitect =
          caller.kind === "architect" && caller.binding.bindingId === review.bindingId;
        const isCoordinator = scope.threadId === review.coordinatorThreadId;
        if (!isOwnerArchitect && !isCoordinator) {
          return yield* refusePublish(
            store,
            review.reviewId,
            at,
            caller.kind === "architect" ? "architect_denied" : "capability_denied",
            "Only the bound architect or the coordinator may publish this review.",
          );
        }
        if (review.origin === "architect-advice") {
          return yield* refusePublish(
            store,
            review.reviewId,
            at,
            "human_publish_required",
            "Prepared Architect publications can only be published by the human Publish button.",
          );
        }
        const binding = yield* store
          .getBindingById(review.bindingId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (binding === null) {
          return yield* refusePublish(
            store,
            review.reviewId,
            at,
            "binding_not_found",
            "The review binding no longer exists.",
          );
        }
        // Validate the credential's frozen scope before changing review state;
        // a drift refusal is recorded below and remains a failed publish.
        yield* loadSwitchParent(scope).pipe(
          Effect.tapError((error) => recordPublishFailure(store, review.reviewId, at, error)),
        );
        return yield* publishAnsweredReview(store, review, binding, {
          idempotencyKey: input.idempotencyKey,
          publishedBy: isOwnerArchitect ? "architect" : "coordinator",
          publishedAt: at,
        });
      }),
    publishArchitectPublication: (input) =>
      Effect.gen(function* () {
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const at = yield* nowIso();
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        const binding = yield* store
          .getActiveBindingByCoordinator(review.coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (binding === null || binding.bindingId !== review.bindingId) {
          return yield* refusePublish(
            store,
            review.reviewId,
            at,
            "binding_not_found",
            "The review no longer belongs to the active Architect binding.",
          );
        }
        const sameKeyReplay =
          review.status === "published" && review.publishIdempotencyKey === input.idempotencyKey;
        if (review.status !== "answered" && !sameKeyReplay) {
          return yield* refusePublish(
            store,
            review.reviewId,
            at,
            "review_state_conflict",
            "Only answered reviews can be published.",
          );
        }
        return yield* publishAnsweredReview(store, review, binding, {
          idempotencyKey: input.idempotencyKey,
          publishedBy: "human",
          publishedAt: at,
        });
      }),
    getCoordinatorBinding: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "query architect bindings");
        // Query scope: coordinator thread itself, human on it, or the bound
        // architect (own binding only).
        const caller = yield* resolveControlPlaneCaller(scope);
        if (caller.kind === "architect") {
          if (caller.binding.coordinatorThreadId !== input.coordinatorThreadId) {
            return yield* failure(
              "architect_denied",
              "Architect threads may only query their own binding.",
            );
          }
        } else {
          if (scope.threadId !== input.coordinatorThreadId) {
            return yield* failure(
              "capability_denied",
              "Only the coordinator thread itself (or a human on it) may query this binding.",
            );
          }
          yield* requireRegisteredOrchestratorWhenBoardPresent(scope);
        }
        const binding = yield* store
          .getActiveBindingByCoordinator(input.coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        return { binding } satisfies OrchestratorMcpGetCoordinatorBindingResult;
      }),
    listArchitectureReviews: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "query architecture reviews");
        const caller = yield* resolveControlPlaneCaller(scope);
        if (caller.kind === "architect") {
          if (caller.binding.coordinatorThreadId !== input.coordinatorThreadId) {
            return yield* failure(
              "architect_denied",
              "Architect threads may only query their own reviews.",
            );
          }
        } else {
          if (scope.threadId !== input.coordinatorThreadId) {
            return yield* failure(
              "capability_denied",
              "Only the coordinator thread itself (or a human on it) may query these reviews.",
            );
          }
          yield* requireRegisteredOrchestratorWhenBoardPresent(scope);
        }
        const reviews = yield* store
          .listReviewsByCoordinator({
            coordinatorThreadId: input.coordinatorThreadId,
            ...(input.status === undefined ? {} : { status: input.status }),
          })
          .pipe(Effect.mapError(mapStoreError("list architecture reviews")));
        return { reviews } satisfies OrchestratorMcpListArchitectureReviewsResult;
      }),
    reconcileAfterRestart: () =>
      Effect.gen(function* () {
        const store = yield* requireArchitectStore();
        const at = yield* nowIso();
        const outcomes: Array<{ readonly bindingId: string; readonly outcome: string }> = [];
        const actives = yield* store
          .listActiveBindings()
          .pipe(Effect.mapError(mapStoreError("list active bindings")));
        for (const binding of actives) {
          const shellOption = yield* loadThreadShell(binding.architectThreadId);
          if (Option.isNone(shellOption)) {
            const createReceiptStatus =
              dependencies.getArchitectCreateReceiptStatus === undefined
                ? "unavailable"
                : yield* dependencies.getArchitectCreateReceiptStatus(binding.bindingId);
            if (createReceiptStatus === "missing") {
              // A binding-first crash before dispatch has no create receipt.
              // Replay the stable command id to heal exactly that window.
              const coordinator = yield* loadThreadShell(binding.coordinatorThreadId);
              if (Option.isNone(coordinator)) {
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: "architect-create-recovery-waiting-for-coordinator",
                });
                continue;
              }
              yield* createArchitectThread(binding, coordinator.value);
              const selected = binding.routingEvidence?.consideredCandidates.at(-1);
              yield* appendPhase1Activity({
                threadId: binding.coordinatorThreadId,
                commandId: `architect-bound:${binding.bindingId}`,
                activityId: `architect-bound:${binding.bindingId}`,
                kind: ARCHITECT_BOUND_ACTIVITY,
                summary: "Architect bound",
                payload: {
                  bindingId: binding.bindingId,
                  coordinatorThreadId: binding.coordinatorThreadId,
                  architectThreadId: binding.architectThreadId,
                  architectTaskEffort: binding.architectTaskEffort,
                  modelSelection:
                    selected === undefined
                      ? null
                      : {
                          instanceId: selected.providerInstanceId,
                          model: selected.model,
                          options: selected.options,
                        },
                  routingEvidence: binding.routingEvidence,
                },
                createdAt: binding.createdAt,
              });
              outcomes.push({
                bindingId: binding.bindingId,
                outcome: "architect-thread-recovered",
              });
            } else {
              // An accepted create receipt proves this is a thread lost while
              // the server was down. A rejected or unavailable receipt cannot
              // safely justify creating a new execution identity either.
              const missingReason = "thread-missing-after-restart";
              const closed = yield* store
                .closeBinding({
                  bindingId: binding.bindingId,
                  status: "detached",
                  replacedByBindingId: null,
                  detachReason: missingReason,
                  idempotencyKey: `architect-missing-thread:${binding.bindingId}`,
                  closeRequestFingerprint: hash({
                    operation: "reconcile-missing-thread",
                    reason: missingReason,
                  }),
                })
                .pipe(Effect.mapError(mapStoreError("detach missing architect thread")));
              if (closed === null) {
                const current = yield* store
                  .getBindingById(binding.bindingId)
                  .pipe(Effect.mapError(mapStoreError("resolve missing architect close race")));
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome:
                    current === null
                      ? "binding-missing-during-reconcile"
                      : `binding-closed-concurrently:${current.status}`,
                });
                continue;
              }
              const revokeReceipt = yield* revokeArchitectCredential(binding.architectThreadId);
              yield* appendPhase1Activity({
                threadId: binding.coordinatorThreadId,
                commandId: `architect-unbound:${binding.bindingId}`,
                activityId: `architect-unbound:${binding.bindingId}`,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect missing after restart",
                payload: {
                  bindingId: binding.bindingId,
                  architectThreadId: binding.architectThreadId,
                  reason: missingReason,
                  replacedByBindingId: closed.replacedByBindingId,
                  revokeReceipt,
                },
                createdAt: at,
              });
              yield* softDeleteArchitectThread(binding.architectThreadId);
              outcomes.push({ bindingId: binding.bindingId, outcome: missingReason });
              continue;
            }
          }
          // Marker-gap replay derives missing wakes exclusively from marker
          // absence: open without review marker → re-wake architect once;
          // published without publish marker → wake coordinator once;
          // answered-unpublished → no wake to anyone.
          const reviews = yield* store
            .listReviewsByCoordinator({ coordinatorThreadId: binding.coordinatorThreadId })
            .pipe(Effect.mapError(mapStoreError("list architecture reviews")));
          for (const review of reviews) {
            if (review.status === "open") {
              const detailOption = yield* loadArchitectActivityDetail(binding.architectThreadId);
              if (
                Option.isSome(detailOption) &&
                needsReviewWakeReplay(
                  detailOption.value.activities,
                  binding.architectThreadId,
                  review.reviewId,
                )
              ) {
                yield* wakeArchitectForReview(review, binding, at);
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: `review-wake-replayed:${review.reviewId}`,
                });
              }
            } else if (review.status === "published") {
              const detailOption = yield* loadArchitectActivityDetail(binding.coordinatorThreadId);
              if (
                Option.isSome(detailOption) &&
                needsPublishWakeReplay(
                  detailOption.value.activities,
                  binding.coordinatorThreadId,
                  review.reviewId,
                )
              ) {
                yield* wakeCoordinatorForPublish(review, binding, at);
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: `publish-wake-replayed:${review.reviewId}`,
                });
              }
            }
          }
        }
        // Binding-less architect-thread sweep: any `arch:` thread with no
        // binding row at all is a race orphan (soft-deleted threads keep
        // their terminal rows, so they are never touched here).
        if (dependencies.getShellSnapshot !== undefined) {
          const snapshot = yield* dependencies
            .getShellSnapshot()
            .pipe(Effect.mapError(orchestrationFailure("read shell snapshot")));
          // A close is durable before credential revocation and the audit
          // notice. If the process stops in that gap while the Architect
          // shell is already missing, the active-binding loop cannot see it
          // next time; replay the terminal audit from retained binding rows.
          for (const coordinator of snapshot.threads) {
            if (coordinator.id.startsWith("arch:")) continue;
            const bindings = yield* store
              .listBindingsByCoordinator(coordinator.id)
              .pipe(Effect.mapError(mapStoreError("read architect binding history")));
            for (const binding of bindings) {
              if (
                binding.status !== "detached" ||
                binding.detachReason !== "thread-missing-after-restart"
              ) {
                continue;
              }
              const detailOption = yield* loadArchitectActivityDetail(coordinator.id);
              if (Option.isNone(detailOption)) {
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: "missing-architect-close-audit-waiting-for-coordinator",
                });
                continue;
              }
              const unboundId = `architect-unbound:${binding.bindingId}`;
              if (detailOption.value.activities.some((activity) => activity.id === unboundId)) {
                continue;
              }
              const revokeReceipt = yield* revokeArchitectCredential(binding.architectThreadId);
              yield* appendPhase1Activity({
                threadId: binding.coordinatorThreadId,
                commandId: unboundId,
                activityId: unboundId,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect missing after restart",
                payload: {
                  bindingId: binding.bindingId,
                  architectThreadId: binding.architectThreadId,
                  reason: "thread-missing-after-restart",
                  replacedByBindingId: binding.replacedByBindingId,
                  revokeReceipt,
                },
                createdAt: at,
              });
              outcomes.push({
                bindingId: binding.bindingId,
                outcome: "missing-architect-close-audit-replayed",
              });
            }
          }
          for (const thread of snapshot.threads) {
            if (!thread.id.startsWith("arch:")) continue;
            const known = yield* store
              .getAnyBindingByArchitect(thread.id)
              .pipe(Effect.mapError(mapStoreError("read architect binding")));
            if (known !== null) {
              if (known.status === "active") continue;
              const receipt = yield* revokeArchitectCredential(ThreadId.make(thread.id));
              yield* appendPhase1Activity({
                threadId: known.coordinatorThreadId,
                commandId: `architect-unbound:${known.bindingId}`,
                activityId: `architect-unbound:${known.bindingId}`,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect soft-deleted during restart reconciliation",
                payload: {
                  bindingId: known.bindingId,
                  architectThreadId: thread.id,
                  reason: known.status,
                  replacedByBindingId: known.replacedByBindingId,
                  revokeReceipt: receipt,
                },
                createdAt: at,
              });
              yield* softDeleteArchitectThread(ThreadId.make(thread.id));
              outcomes.push({
                bindingId: known.bindingId,
                outcome: "terminal-thread-soft-deleted",
              });
              continue;
            }
            const receipt = yield* revokeArchitectCredential(ThreadId.make(thread.id));
            yield* appendPhase1Activity({
              threadId: ThreadId.make(thread.id),
              commandId: `architect-unbound-orphan:${thread.id}`,
              activityId: `architect-unbound-orphan:${thread.id}`,
              kind: ARCHITECT_UNBOUND_ACTIVITY,
              summary: "Binding-less architect thread soft-deleted",
              payload: {
                bindingId: null,
                architectThreadId: thread.id,
                reason: "binding-race-lost",
                revokeReceipt: receipt,
              },
              createdAt: at,
            });
            yield* softDeleteArchitectThread(ThreadId.make(thread.id));
            outcomes.push({ bindingId: thread.id, outcome: "orphan-soft-deleted" });
          }
        }
        return outcomes;
      }),
  };
  return service;
}
