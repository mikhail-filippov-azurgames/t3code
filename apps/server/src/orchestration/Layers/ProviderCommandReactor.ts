import {
  type ChatAttachment,
  CommandId,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  EventId,
  type FollowUpBehavior,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationEvent,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  loadDelegationPermissionEnvelope,
  recoverDelegationChildCaps,
} from "../../provider/DelegationPermissionEnvelope.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { CoordinatorArchitectRepository } from "../../persistence/Services/CoordinatorArchitect.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  formatThreadTitleContext,
  type ThreadTitleMessage,
} from "../../textGeneration/ThreadTitleContext.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import { handledDelegationWakeMessageIds } from "../delegatedTaskWake.ts";
import {
  PUBLISH_WAKE_DELIVERED_ACTIVITY,
  REVIEW_WAKE_DELIVERED_ACTIVITY,
  REVIEW_PUBLISHED_ACTIVITY,
  publishWakeDeliveredMarkerId,
  publishWakeReviewIdFromMessageId,
  reviewWakeDeliveredMarkerId,
  reviewWakeReviewIdFromMessageId,
} from "../coordinatorArchitect.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

const PROVIDER_HANDOFF_CONTEXT_MAX_CHARS = 48_000;
const PROVIDER_HANDOFF_CONTEXT_OMITTED = "[Earlier provider context truncated]\n\n";
const PROVIDER_HANDOFF_CONTEXT_OPEN =
  "[Conversation context transferred from the previous provider. Treat this transcript as prior conversation history, continue unresolved work from it, and use the current request below as the latest user instruction.]\n<previous_provider_conversation>";
const PROVIDER_HANDOFF_CONTEXT_CLOSE = "</previous_provider_conversation>";
const DELEGATION_WAKE_MESSAGE_PREFIX = "delegation-wake:";
const DELEGATION_WAKE_DELIVERED_ACTIVITY = "delegation.wake-delivered";
const DELEGATION_COMPLETED_ACTIVITY = "delegation.completed";
const PROVIDER_TURN_START_FAILED_ACTIVITY = "provider.turn.start.failed";
const DELEGATION_WAKE_CONTEXT_MAX_CHARS = 2_000;
const TURN_SEND_CLAIMED_ACTIVITY = "provider.turn.send.claimed";
const TURN_SEND_UNCERTAIN_ACTIVITY = "provider.turn.send.uncertain";

type ProviderHandoffMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly id: MessageId;
};

function limitProviderHandoffTranscript(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= PROVIDER_HANDOFF_CONTEXT_OMITTED.length) return "";
  const available = budget - PROVIDER_HANDOFF_CONTEXT_OMITTED.length;
  const head = Math.ceil(available / 3);
  const tail = available - head;
  return `${text.slice(0, head)}${PROVIDER_HANDOFF_CONTEXT_OMITTED}${tail > 0 ? text.slice(-tail) : ""}`;
}

function buildProviderHandoffContext(input: {
  readonly messages: ReadonlyArray<ProviderHandoffMessage>;
  readonly currentMessageId: MessageId;
  readonly currentMessageText: string;
  readonly excludedMessageIds?: ReadonlySet<MessageId>;
}): string | undefined {
  const currentMessageIndex = input.messages.findIndex(
    (message) => message.id === input.currentMessageId,
  );
  const historyMessages =
    currentMessageIndex >= 0
      ? input.messages.slice(0, currentMessageIndex)
      : input.messages.filter((message) => message.id !== input.currentMessageId);
  const sections = historyMessages.flatMap((message) => {
    if (
      message.id === input.currentMessageId ||
      input.excludedMessageIds?.has(message.id) === true ||
      message.text.trim().length === 0
    )
      return [];
    const text = assistantCitationsToPlainText(message.text).trim();
    const attachmentNames = message.attachments
      ?.map((attachment) => attachment.name)
      .filter((name) => name.trim().length > 0)
      .join(", ");
    const contents = [
      text,
      attachmentNames === undefined || attachmentNames.length === 0
        ? undefined
        : `[Previous attachments: ${attachmentNames}]`,
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join("\n");
    return contents.length > 0 ? [`${message.role.toUpperCase()}:\n${contents}`] : [];
  });
  if (sections.length === 0) return undefined;

  const transcript = sections.join("\n\n");
  const wrapperLength =
    PROVIDER_HANDOFF_CONTEXT_OPEN.length + PROVIDER_HANDOFF_CONTEXT_CLOSE.length + 4;
  const currentRequestLength = input.currentMessageText.length + 40;
  const budget = Math.min(
    PROVIDER_HANDOFF_CONTEXT_MAX_CHARS,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS - wrapperLength - currentRequestLength,
  );
  const limitedTranscript = limitProviderHandoffTranscript(transcript, budget);
  if (limitedTranscript.length === 0) return undefined;
  return [
    PROVIDER_HANDOFF_CONTEXT_OPEN,
    limitedTranscript,
    PROVIDER_HANDOFF_CONTEXT_CLOSE,
    "<current_user_request>",
    input.currentMessageText,
    "</current_user_request>",
  ].join("\n");
}

export type CrossDriverHandoffResolution =
  | { readonly kind: "not-required" | "trivial-history" }
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * Gate a cross-driver restart onto a fresh provider session. The durable
 * transcript must travel explicitly; an empty history (or nothing beyond the
 * current prompt) is allowed by explicit check, anything else without a
 * transferable transcript fails instead of sending a bare prompt.
 */
export function resolveCrossDriverHandoff(input: {
  readonly required: boolean;
  readonly detail: OrchestrationThread | undefined;
  readonly currentMessageId: MessageId;
  readonly currentMessageText: string;
  readonly excludedMessageIds?: ReadonlySet<MessageId>;
}): CrossDriverHandoffResolution {
  if (!input.required) return { kind: "not-required" };
  if (input.detail === undefined) {
    return {
      kind: "unsupported",
      reason:
        "The previous provider session ended without readable conversation history, so the new provider cannot continue it.",
    };
  }
  const context = buildProviderHandoffContext({
    messages: input.detail.messages,
    currentMessageId: input.currentMessageId,
    currentMessageText: input.currentMessageText,
    ...(input.excludedMessageIds === undefined
      ? {}
      : { excludedMessageIds: input.excludedMessageIds }),
  });
  if (context !== undefined) return { kind: "context", text: context };
  const priorContent = input.detail.messages.filter(
    (message) =>
      message.id !== input.currentMessageId &&
      input.excludedMessageIds?.has(message.id) !== true &&
      (message.text.trim().length > 0 ||
        (message.attachments?.some((attachment) => attachment.name.trim().length > 0) ?? false)),
  );
  if (priorContent.length === 0) return { kind: "trivial-history" };
  return {
    kind: "unsupported",
    reason:
      "The previous provider conversation could not be transferred within the provider input budget, so the new provider cannot continue it.",
  };
}

type WakeDelivery = {
  readonly inputPrefix: string | undefined;
  readonly wakeMessageIds: ReadonlyArray<MessageId>;
  readonly handoffExcludedMessageIds: ReadonlySet<MessageId>;
};

function buildWakeDelivery(
  detail: OrchestrationThread | undefined,
  currentMessageId?: MessageId,
): WakeDelivery {
  if (detail === undefined) {
    return { inputPrefix: undefined, wakeMessageIds: [], handoffExcludedMessageIds: new Set() };
  }

  const handledMessageIds = handledDelegationWakeMessageIds({
    threadId: String(detail.id),
    ...(currentMessageId === undefined ? {} : { currentMessageId: String(currentMessageId) }),
    messageIds: new Set(detail.messages.map((message) => String(message.id))),
    activities: detail.activities,
  });
  const handoffExcludedMessageIds = new Set<MessageId>(
    [...handledMessageIds].map((messageId) => MessageId.make(messageId)),
  );
  const undeliveredWakeMessages = detail.messages.filter(
    (message) =>
      message.role === "system" &&
      message.id.startsWith(DELEGATION_WAKE_MESSAGE_PREFIX) &&
      !handledMessageIds.has(message.id),
  );
  if (undeliveredWakeMessages.length === 0) {
    return { inputPrefix: undefined, wakeMessageIds: [], handoffExcludedMessageIds };
  }

  const selectedBlocks: Array<string> = [];
  const selectedMessageIds: Array<MessageId> = [];
  let selectedLength = 0;
  for (let index = undeliveredWakeMessages.length - 1; index >= 0; index -= 1) {
    const message = undeliveredWakeMessages[index]!;
    const block = `[Delegated child result]\n${message.text.trim()}\n[/Delegated child result]`;
    const separatorLength = selectedBlocks.length === 0 ? 0 : 2;
    const remaining = DELEGATION_WAKE_CONTEXT_MAX_CHARS - selectedLength - separatorLength;
    if (remaining <= 0) break;
    selectedBlocks.unshift(block.slice(0, remaining));
    selectedMessageIds.unshift(message.id);
    selectedLength += Math.min(block.length, remaining) + separatorLength;
    if (block.length > remaining) break;
  }

  return {
    inputPrefix: selectedBlocks.join("\n\n"),
    wakeMessageIds: selectedMessageIds,
    handoffExcludedMessageIds,
  };
}

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled"
      | "thread.session-set";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DELEGATION_CANCEL_REQUESTED_ACTIVITY = "delegation.cancel-requested";
const DELEGATION_CANCELLED_ACTIVITY = "delegation.cancelled";
const DELEGATION_PROVIDER_BOUND_ACTIVITY = "delegation.provider-bound";

function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const coordinatorArchitectRepository = yield* CoordinatorArchitectRepository;
  /** Environment settings with the thread's project overrides applied. */
  const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const settings = yield* serverSettingsService.getSettings;
    if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
      .settings;
  });
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const appendWakeDeliveryMarker = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly wakeMessageIds: ReadonlyArray<MessageId>;
    readonly createdAt: string;
  }) {
    if (input.wakeMessageIds.length === 0) return;
    const markerId = `delegation-wake-delivered:${input.threadId}:${[...input.wakeMessageIds]
      .sort()
      .join(",")}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(markerId),
      threadId: input.threadId,
      activity: {
        id: EventId.make(markerId),
        tone: "info",
        kind: DELEGATION_WAKE_DELIVERED_ACTIVITY,
        summary: "Delegated child results delivered",
        payload: { wakeMessageIds: input.wakeMessageIds },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });
  // The delivery proof for a published architecture review. The wake is only
  // real once `sendTurn` resolves, so the review row is updated from this same
  // post-send path, never at the dispatch site, where an accepted command is
  // not a delivered send.
  const markArchitecturePublishDelivered = (reviewId: string, deliveredAt: string) =>
    coordinatorArchitectRepository.markPublishDelivered({ reviewId, deliveredAt }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("architecture publish delivery could not be recorded", {
          reviewId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // Symmetric to the marker: a send that fails after dispatch must leave the
  // reason on the review so the coordinator sees a failed delivery instead of
  // a silent success. No-ops for any message that is not a publish wake.
  const recordArchitecturePublishFailure = (input: {
    readonly messageId: MessageId;
    readonly detail: string;
    readonly attemptedAt: string;
  }) => {
    const reviewId = publishWakeReviewIdFromMessageId(String(input.messageId));
    if (reviewId === null) return Effect.void;
    return coordinatorArchitectRepository
      .recordPublishFailure({
        reviewId,
        reason: "provider_send_failed",
        message: input.detail.slice(0, 2_000),
        attemptedAt: input.attemptedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("architecture publish failure could not be recorded", {
            reviewId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  };

  // Record delivery only after the provider confirms `sendTurn`.
  const appendArchitectureReviewWakeMarker = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly createdAt: string;
  }) {
    const reviewId = reviewWakeReviewIdFromMessageId(
      String(input.messageId),
      String(input.threadId),
    );
    if (reviewId === null) return;
    const markerId = reviewWakeDeliveredMarkerId(String(input.threadId), reviewId);
    const detail = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId, {
        activityKinds: [REVIEW_WAKE_DELIVERED_ACTIVITY],
        activityHistory: "complete",
      })
      .pipe(
        Effect.retry({ times: 2, schedule: Schedule.exponential("50 millis") }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          return Effect.logWarning("review wake delivery marker context could not be loaded", {
            threadId: input.threadId,
            messageId: input.messageId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none<OrchestrationThread>()));
        }),
      );
    if (Option.isNone(detail)) return;
    if (detail.value.activities.some((activity) => activity.id === markerId)) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(markerId),
      threadId: input.threadId,
      activity: {
        id: EventId.make(markerId),
        tone: "info",
        kind: REVIEW_WAKE_DELIVERED_ACTIVITY,
        summary: "Architect review wake delivered",
        payload: { reviewId },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // The architecture publish wake proves the coordinator wake reached the
  // provider only after `sendTurn` resolves. Appending it here (never at the
  // dispatch site) keeps a failed send from being recorded as a delivered
  // wake; the payload is copied from the published content already on the
  // coordinator thread.
  const appendArchitecturePublishWakeMarker = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly createdAt: string;
  }) {
    const reviewId = publishWakeReviewIdFromMessageId(String(input.messageId));
    if (reviewId === null) return;
    const markerId = publishWakeDeliveredMarkerId(String(input.threadId), reviewId);
    const detail = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId, {
        activityKinds: [REVIEW_PUBLISHED_ACTIVITY, PUBLISH_WAKE_DELIVERED_ACTIVITY],
        activityHistory: "complete",
      })
      .pipe(
        Effect.retry({ times: 2, schedule: Schedule.exponential("50 millis") }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          return Effect.logWarning("publish wake delivery marker context could not be loaded", {
            threadId: input.threadId,
            messageId: input.messageId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none<OrchestrationThread>()));
        }),
      );
    if (Option.isNone(detail)) return;
    if (!detail.value.activities.some((activity) => activity.id === markerId)) {
      const published = detail.value.activities.find(
        (activity) =>
          activity.kind === REVIEW_PUBLISHED_ACTIVITY &&
          Predicate.isObject(activity.payload) &&
          activity.payload.reviewId === reviewId,
      );
      const publishedPayload = Predicate.isObject(published?.payload)
        ? published.payload
        : undefined;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`${markerId}:command`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(markerId),
          tone: "info",
          kind: PUBLISH_WAKE_DELIVERED_ACTIVITY,
          summary: "Coordinator publish wake delivered",
          payload: {
            reviewId,
            disposition: publishedPayload?.disposition ?? null,
            summary: publishedPayload?.summary ?? null,
            refs: publishedPayload?.refs ?? null,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }
    // Send confirmed (fresh or healed replay): record delivery on the row.
    yield* markArchitecturePublishDelivered(reviewId, input.createdAt);
  });
  // Durable at-most-once marker for one provider send. Persisted before
  // sendTurn runs: any provider-side turn implies a persisted claim, so a
  // restart never re-sends a claimed request without a human resending it.
  const appendTurnSendClaim = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("provider-turn-send-claim"),
      threadId: input.threadId,
      activity: {
        id: yield* serverEventId(),
        tone: "info",
        kind: TURN_SEND_CLAIMED_ACTIVITY,
        summary: "Provider turn send claimed",
        payload: { requestId: input.messageId },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });
  // A claim (or legacy binding) without a recorded turn means the send
  // may never have reached the provider. Never re-send it automatically;
  // flag it once so a human can check and resend. A failed linkage read
  // also stays silent.
  const maybeFlagUncertainTurnSend = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly hasUncertainDiagnostic: boolean;
    readonly createdAt: string;
  }) {
    if (input.hasUncertainDiagnostic) return;
    const linkedTurn = yield* projectionSnapshotQuery
      .getTurnByPendingMessageId({ threadId: input.threadId, messageId: input.messageId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor skips uncertain turn send check", {
            threadId: input.threadId,
            messageId: input.messageId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        ),
      );
    if (linkedTurn === undefined || Option.isSome(linkedTurn)) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("provider-turn-send-uncertain"),
      threadId: input.threadId,
      activity: {
        id: yield* serverEventId(),
        tone: "error",
        kind: TURN_SEND_UNCERTAIN_ACTIVITY,
        summary: "Queued follow-up may not have been sent",
        payload: {
          requestId: input.messageId,
          detail:
            "A provider send for this queued follow-up was recorded (send claim or provider binding) but no turn was recorded for it, likely a crash before the provider accepted it. It was not billed again automatically. Resend the message to retry.",
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });
  // Durable duplicate guard for delegation sends. The in-memory
  // turn-start key is TTL/size bound, so a redelivered event processed
  // after eviction must still not send twice: the first attempt claims
  // before sending, so any prior failed/claimed/bound marker for this
  // message means this attempt is stale. Unreadable history skips without
  // sending; a restart retries the request.
  const hasPriorDelegatedSendAttempt = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) {
    const detail = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId, {
        activityKinds: [
          PROVIDER_TURN_START_FAILED_ACTIVITY,
          TURN_SEND_CLAIMED_ACTIVITY,
          TURN_SEND_UNCERTAIN_ACTIVITY,
          DELEGATION_PROVIDER_BOUND_ACTIVITY,
        ],
        activityHistory: "complete",
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning(
            "provider command reactor skips turn start with unreadable history",
            {
              threadId: input.threadId,
              messageId: input.messageId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.as(Option.none()));
        }),
      );
    if (Option.isNone(detail)) return undefined;
    return readQueuedTurnSendMarkers(detail.value.activities, input.messageId);
  });
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  // Metadata updates are durable provider switches. Keep them separate from
  // the ephemeral model selection remembered from a previous turn so a stale
  // cache entry cannot undo a switch before the next send.
  const threadMetadataModelSelections = new Map<string, ModelSelection>();
  const compactingThreadIds = new Set<ThreadId>();
  type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  // Turn starts received while a thread compacts, replayed in order once its session is restored.
  const turnsAfterCompaction = new Map<ThreadId, Array<QueuedTurnStart>>();
  // Replay command id → the queued turn start it re-requests. `sent` settles once the replay's
  // provider send finishes, which is what lets the next queued turn follow it in order.
  const resumedTurnStarts = new Map<
    CommandId,
    {
      readonly event: QueuedTurnStart;
      readonly queued: Array<QueuedTurnStart>;
      readonly sent: Deferred.Deferred<void>;
    }
  >();
  const stoppingThreadIds = new Set<ThreadId>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly code?: "provider_configuration_changed";
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
              ...(input.code ? { code: input.code } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const loadDelegationActivities = Effect.fnUntraced(function* (threadId: ThreadId) {
    const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId, {
      activityKinds: [
        DELEGATION_CANCEL_REQUESTED_ACTIVITY,
        DELEGATION_CANCELLED_ACTIVITY,
        DELEGATION_PROVIDER_BOUND_ACTIVITY,
      ],
      activityHistory: "complete",
    });
    return Option.isSome(detail) ? detail.value.activities : [];
  });

  const hasDelegationCancellationIntent = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const activities = yield* loadDelegationActivities(threadId);
    return activities.some(
      (activity) =>
        activity.kind === DELEGATION_CANCEL_REQUESTED_ACTIVITY &&
        Predicate.isObject(activity.payload) &&
        activity.payload.taskId === threadId &&
        activity.payload.delegatedMessageId === messageId,
    );
  });

  const appendDelegationCancelled = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly reason: "provider-interrupted" | "provider-not-active" | "start-suppressed";
  }) {
    const id = `server:delegation-cancelled:${input.messageId}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(id),
      threadId: input.threadId,
      activity: {
        id: EventId.make(id),
        tone: "info",
        kind: DELEGATION_CANCELLED_ACTIVITY,
        summary: "Delegated task cancelled",
        payload: {
          version: 1,
          taskId: input.threadId,
          delegatedMessageId: input.messageId,
          delegatedTurnId: input.turnId,
          reason: input.reason,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const appendDelegationProviderBound = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly providerConfigFingerprint: string;
    readonly createdAt: string;
  }) {
    const session = (yield* providerService.listSessions()).find(
      (candidate) => candidate.threadId === input.threadId,
    );
    if (session?.providerInstanceId === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(session?.provider),
        method: "thread.turn.start",
        detail: `Delegated thread '${input.threadId}' has no runtime-bound provider instance.`,
      });
    }
    const instance = yield* providerService.getInstanceInfo(session.providerInstanceId);
    const id = `server:delegation-provider-bound:${input.messageId}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(id),
      threadId: input.threadId,
      activity: {
        id: EventId.make(id),
        tone: "info",
        kind: DELEGATION_PROVIDER_BOUND_ACTIVITY,
        summary: "Delegated task provider bound",
        payload: {
          version: 1,
          taskId: input.threadId,
          delegatedMessageId: input.messageId,
          providerInstanceId: session.providerInstanceId,
          driverKind: instance.driverKind,
          providerConfigFingerprint: input.providerConfigFingerprint,
          observedAt: input.createdAt,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const cancelTurnsAfterCompaction = Effect.fn("cancelTurnsAfterCompaction")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    turnsAfterCompaction.delete(threadId);
    for (const event of queued) {
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        summary: "Queued message was not sent",
        detail,
        turnId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        requestId: event.payload.messageId,
      }).pipe(Effect.ignore({ log: true, message: "failed to report canceled queued message" }));
    }
  });

  const resumeTurnsAfterCompaction = Effect.fn("resumeTurnsAfterCompaction")(function* (
    threadId: ThreadId,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    while (queued.length > 0 && turnsAfterCompaction.get(threadId) === queued) {
      const event = queued[0]!;
      const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
        threadId,
        messageId: event.payload.messageId,
      });
      if (turnsAfterCompaction.get(threadId) !== queued) return;
      // In flight from here on: a cancellation reports it when the replay runs, not from the queue.
      queued.shift();
      if (Option.isNone(turnStart)) continue;
      // Reissue the durable request after restoration clears compaction's
      // pending slot. Reusing the message id preserves a single user bubble.
      const commandId = yield* serverCommandId("after-compaction");
      const sent = yield* Deferred.make<void>();
      resumedTurnStarts.set(commandId, { event, queued, sent });
      const { messageId, ...request } = event.payload;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId,
          ...request,
          message: {
            messageId,
            role: "user",
            text: turnStart.value.message.text,
            attachments: turnStart.value.message.attachments ?? [],
          },
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              resumedTurnStarts.delete(commandId);
              queued.unshift(event);
            }),
          ),
        );
      yield* Deferred.await(sent);
      resumedTurnStarts.delete(commandId);
    }
    if (turnsAfterCompaction.get(threadId) === queued) turnsAfterCompaction.delete(threadId);
  });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    if (isProviderAdapterRequestError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterValidationError(failReason?.error)) {
      return failReason.error.issue;
    }
    if (isProviderWorkspaceMissingError(failReason?.error)) {
      return failReason.error.message;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const restoreCompaction = Effect.fnUntraced(function* (threadId: ThreadId, fromRunning = false) {
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    const thread = yield* resolveThreadShell(threadId);
    if (!thread?.session) return;
    if (
      thread.session.status !== "starting" &&
      thread.session.status !== "ready" &&
      (!fromRunning || thread.session.status !== "running")
    )
      return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    yield* setThreadSession({
      threadId,
      session: {
        ...thread.session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to recreate worktree", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const verifyDelegationConfigForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly expectedFingerprint?: string;
  }) {
    if (input.expectedFingerprint === undefined) return;
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return yield* new ProviderAdapterRequestError({
        provider: "delegated provider",
        method: "thread.turn.start",
        detail: `provider_configuration_changed: project '${thread.projectId}' is unavailable.`,
      });
    }
    const settings = yield* projectSettingsForThread(input.threadId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: "delegated provider",
            method: "thread.turn.start",
            detail: "provider_configuration_changed: effective provider settings are unreadable.",
          }),
      ),
    );
    const modelSelection = input.modelSelection ?? thread.modelSelection;
    const instanceConfig = deriveProviderInstanceConfigMap(settings)[modelSelection.instanceId];
    if (instanceConfig === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: String(modelSelection.instanceId),
        method: "thread.turn.start",
        detail: `provider_configuration_changed: provider instance '${modelSelection.instanceId}' is no longer configured.`,
      });
    }
    // Verify against the canonical frozen child caps, not the current surface
    // settings: the current set is only a fast path, the exact-subset search
    // recovers delegations accepted under different flags. Anything else is
    // configuration drift and fails closed.
    const preferredCaps = new Set<string>(["pull-requests", "orchestration"]);
    if (settings.enableAgentBrowserAccess) preferredCaps.add("preview");
    if (settings.enableAgentDeviceAccess) preferredCaps.add("device");
    const worktreePath = thread.worktreePath ?? project.workspaceRoot;
    const baseEnvelopeInput = {
      driverKind: instanceConfig.driver,
      runtimeMode: thread.runtimeMode,
      interactionMode: input.interactionMode ?? thread.interactionMode,
      instanceConfig,
      environment: process.env,
      workspaceRoot: project.workspaceRoot,
      worktreePath,
      branch: thread.branch,
    } as const;
    const recovery = yield* recoverDelegationChildCaps({
      expectedFingerprint: input.expectedFingerprint,
      preferredCaps,
      loadWithCaps: (t3McpCapabilities) =>
        loadDelegationPermissionEnvelope({ ...baseEnvelopeInput, t3McpCapabilities }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
    });
    if (recovery.status !== "recovered") {
      const reason =
        recovery.status === "ambiguous"
          ? "the delegated capability scope is ambiguous"
          : "the effective provider configuration changed after delegation was accepted";
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(instanceConfig.driver),
        method: "thread.turn.start",
        detail: `provider_configuration_changed: ${reason}.`,
      });
    }
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly interactionMode?: "default" | "plan";
      readonly delegationConfigFingerprint?: string;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    // A provider switch is persisted as thread metadata before the next turn.
    // That durable target is the explicit signal that a cross-driver restart is
    // intentional; a one-off turn model override must keep the old rejection.
    const durableSwitchSelection =
      threadMetadataModelSelections.get(threadId) ??
      (thread.modelSelection.instanceId !== currentInstanceId ? thread.modelSelection : undefined);
    const isCrossDriverProviderSwitch =
      desiredInstanceId !== currentInstanceId &&
      durableSwitchSelection !== undefined &&
      Equal.equals(durableSwitchSelection, desiredModelSelection) &&
      currentInfo.driverKind !== desiredInfo.driverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind && !isCrossDriverProviderSwitch) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.driverKind === desiredInfo.driverKind &&
        currentInfo.continuationIdentity.continuationKey !==
          desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      verifyDelegationConfigForThread({
        threadId,
        modelSelection: desiredModelSelection,
        ...(options?.interactionMode === undefined
          ? {}
          : { interactionMode: options.interactionMode }),
        ...(options?.delegationConfigFingerprint === undefined
          ? {}
          : { expectedFingerprint: options.delegationConfigFingerprint }),
      }).pipe(
        Effect.andThen(
          providerService
            .startSession(threadId, {
              threadId,
              ...(preferredProvider ? { provider: preferredProvider } : {}),
              providerInstanceId: desiredInstanceId,
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              ...(thread.title ? { title: thread.title } : {}),
              modelSelection: desiredModelSelection,
              ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              runtimeMode: desiredRuntimeMode,
            })
            .pipe(Effect.tap(() => refreshWorkspaceSnapshot)),
        ),
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        yield* refreshWorkspaceSnapshot;
        return existingSessionThreadId;
      }

      const resumeCursor =
        shouldRestartForModelChange || isCrossDriverProviderSwitch
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentMessageId: MessageId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly delegationConfigFingerprint?: string;
    readonly followUpBehavior?: FollowUpBehavior;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const activeSessionBeforeEnsure = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const metadataModelSelection = threadMetadataModelSelections.get(input.threadId);
    const cachedModelSelection = threadModelSelections.get(input.threadId);
    const providerInstanceChangedBeforeEnsure =
      activeSessionBeforeEnsure?.providerInstanceId !== undefined &&
      activeSessionBeforeEnsure.providerInstanceId !== thread.modelSelection.instanceId;
    const modelSelectionForEnsure =
      input.modelSelection ??
      metadataModelSelection ??
      (providerInstanceChangedBeforeEnsure ? thread.modelSelection : cachedModelSelection);
    // The durable metadata selection wins over the ephemeral model chosen by a
    // previous turn. If the metadata event has not reached the reactor yet,
    // an instance change in the read model is enough to select the persisted
    // target for this send.
    const requestedModelSelection =
      input.modelSelection ??
      metadataModelSelection ??
      (providerInstanceChangedBeforeEnsure
        ? thread.modelSelection
        : (cachedModelSelection ?? thread.modelSelection));
    let providerHandoffRequired = false;
    if (
      activeSessionBeforeEnsure?.providerInstanceId !== undefined &&
      activeSessionBeforeEnsure.providerInstanceId !== requestedModelSelection.instanceId
    ) {
      const currentProviderInfo = yield* providerService.getInstanceInfo(
        activeSessionBeforeEnsure.providerInstanceId,
      );
      const requestedProviderInfo = yield* providerService.getInstanceInfo(
        requestedModelSelection.instanceId,
      );
      providerHandoffRequired = currentProviderInfo.driverKind !== requestedProviderInfo.driverKind;
    }
    if (!providerHandoffRequired) {
      // The live session may already be gone (restart, settle); the
      // read-model session still names the previous provider. A cross-driver
      // change without any live session must not start bare either.
      const previousInstanceId =
        activeSessionBeforeEnsure?.providerInstanceId ?? thread.session?.providerInstanceId;
      if (
        previousInstanceId !== undefined &&
        previousInstanceId !== requestedModelSelection.instanceId
      ) {
        const previousInfo = yield* providerService.getInstanceInfo(previousInstanceId).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none()),
        );
        const requestedProviderInfo = yield* providerService.getInstanceInfo(
          requestedModelSelection.instanceId,
        );
        providerHandoffRequired =
          Option.isNone(previousInfo) ||
          previousInfo.value.driverKind !== requestedProviderInfo.driverKind;
      }
    }
    const isSyntheticDelegationWakeTurn =
      String(input.currentMessageId).startsWith("delegation-wake-turn:") ||
      String(input.currentMessageId).startsWith("delegation-wake-drain:");
    const threadDetailForWake = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId, {
        activityKinds: [
          DELEGATION_COMPLETED_ACTIVITY,
          DELEGATION_WAKE_DELIVERED_ACTIVITY,
          "provider.turn.start.failed",
        ],
        activityHistory: "complete",
      })
      .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("100 millis") }))
      .pipe(
        Effect.catchCause((cause) => {
          const logged = Effect.logWarning("delegation wake delivery context could not be loaded", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          });
          return isSyntheticDelegationWakeTurn
            ? logged.pipe(Effect.andThen(Effect.failCause(cause)))
            : logged.pipe(Effect.as(Option.none<OrchestrationThread>()));
        }),
      );
    const wakeDelivery = buildWakeDelivery(
      Option.getOrUndefined(threadDetailForWake),
      input.currentMessageId,
    );
    // A cross-driver restart creates a fresh provider-native session. Carry the
    // durable transcript into its first prompt; subsequent turns stay native
    // and must not receive the transcript a second time. Missing history fails
    // before any session restart, never as a silent bare prompt.
    const handoff = resolveCrossDriverHandoff({
      required: providerHandoffRequired,
      detail: Option.getOrUndefined(threadDetailForWake),
      currentMessageId: input.currentMessageId,
      currentMessageText: input.messageText,
      excludedMessageIds: wakeDelivery.handoffExcludedMessageIds,
    });
    if (handoff.kind === "unsupported") {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabelFromInstanceHint({
          instanceId: String(requestedModelSelection.instanceId),
        }),
        method: "thread.turn.start",
        detail: `provider_handoff_unsupported: ${handoff.reason}`,
      });
    }
    const providerHandoffContext = handoff.kind === "context" ? handoff.text : undefined;
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(modelSelectionForEnsure !== undefined ? { modelSelection: modelSelectionForEnsure } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.delegationConfigFingerprint !== undefined
        ? { delegationConfigFingerprint: input.delegationConfigFingerprint }
        : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const wakeInput =
      wakeDelivery.inputPrefix === undefined
        ? normalizedInput
        : [wakeDelivery.inputPrefix, normalizedInput]
            .filter((value): value is string => value !== undefined)
            .join("\n\n");
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection !== undefined || metadataModelSelection !== undefined
          ? requestedModelSelection
          : undefined;

    yield* verifyDelegationConfigForThread({
      threadId: input.threadId,
      modelSelection: requestedModelSelection,
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      ...(input.delegationConfigFingerprint === undefined
        ? {}
        : { expectedFingerprint: input.delegationConfigFingerprint }),
    });

    return {
      request: {
        threadId: input.threadId,
        ...(providerHandoffContext !== undefined
          ? { input: providerHandoffContext }
          : wakeInput
            ? { input: wakeInput }
            : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.followUpBehavior !== undefined
          ? { followUpBehavior: input.followUpBehavior }
          : {}),
      },
      wakeMessageIds: wakeDelivery.wakeMessageIds,
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* projectSettingsForThread(input.threadId);
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly expectedTitle: string;
      readonly expectedVersion: CommandId | null;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
          input.threadId,
        );

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.title.generate.complete",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title === DEFAULT_THREAD_TITLE ? input.expectedTitle : generated.title,
          expectedTitle: input.expectedTitle,
          expectedVersion: input.expectedVersion,
          needsRefinement:
            generated.needsRefinement === true || generated.title === DEFAULT_THREAD_TITLE,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const maybeRefineThreadTitle = Effect.fn("maybeRefineThreadTitle")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (
      !thread?.titleState?.needsRefinement ||
      thread.titleState.source !== "generated" ||
      thread.titleRegeneration != null ||
      thread.latestTurn?.state !== "completed" ||
      thread.session?.status !== "ready"
    )
      return;
    const detail = yield* resolveThreadDetail(threadId);
    if (!detail || detail.messages.filter((message) => message.role === "user").length !== 1)
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.title.refine",
      commandId: yield* serverCommandId("thread-title-refine"),
      threadId,
      expectedVersion: thread.titleState.version,
    });
  });

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettingsService.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findPendingThreadTitles = Effect.fn("findPendingThreadTitles")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return {
      interruptedRegenerations: readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      }),
      refinementThreadIds: readModel.threads
        .filter((thread) => thread.titleState?.needsRefinement)
        .map((thread) => thread.id),
    };
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const resumed =
      receivedEvent.commandId !== null ? resumedTurnStarts.get(receivedEvent.commandId) : undefined;
    const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
      threadId: thread.id,
      messageId: event.payload.messageId,
    });
    if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
      return;
    }
    const { message, hasOtherUserMessages } = turnStart.value;
    const appendTurnStartFailure = (
      summary: string,
      detail: string,
      code?: "provider_configuration_changed",
    ) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
        ...(code === undefined ? {} : { code }),
      });
    if (resumed && turnsAfterCompaction.get(event.payload.threadId) !== resumed.queued) {
      return yield* appendTurnStartFailure(
        "Queued message was not sent",
        "The queued message was canceled before it could resume. Send it again to continue.",
      );
    }
    if (
      event.payload.delegationConfigFingerprint !== undefined &&
      (yield* hasDelegationCancellationIntent(event.payload.threadId, event.payload.messageId))
    ) {
      yield* appendDelegationCancelled({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        turnId: null,
        createdAt: event.payload.createdAt,
        reason: "start-suppressed",
      });
      return;
    }
    if (event.payload.delegationConfigFingerprint !== undefined) {
      const priorAttempt = yield* hasPriorDelegatedSendAttempt({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
      });
      if (priorAttempt === undefined) return;
      if (priorAttempt.hasFailed || priorAttempt.hasClaim || priorAttempt.hasLegacyBound) return;
    }
    // Resolve how a follow-up sent while a turn is still running is
    // delivered. The adapter executes the steer (interrupt first, then send);
    // the reactor only resolves and forwards the behavior. Muse sessions
    // cannot overlap turns on one MSP session at all, so an explicit "queue"
    // would wedge the thread in "thinking" — default those to "steer".
    const requestedFollowUp = event.payload.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR;
    const effectiveFollowUp: FollowUpBehavior =
      requestedFollowUp === "queue" &&
      thread.session?.status === "running" &&
      thread.session?.activeTurnId != null &&
      thread.session?.providerName === ProviderDriverKind.make("museCode")
        ? "steer"
        : requestedFollowUp;

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendTurnStartFailure(
            "Provider turn start failed",
            detail,
            detail.includes("provider_configuration_changed")
              ? "provider_configuration_changed"
              : undefined,
          ),
        ),
        Effect.flatMap(() =>
          recordArchitecturePublishFailure({
            messageId: event.payload.messageId,
            detail,
            attemptedAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const authCommandHandled = yield* Effect.gen(function* () {
      // Native account commands belong to the thread's existing provider session.
      const instanceId =
        thread.session?.providerInstanceId ??
        event.payload.modelSelection?.instanceId ??
        thread.modelSelection.instanceId;
      const handled = yield* providerAuthService.tryHandlePromptCommand({
        instanceId,
        text: message.text,
        hasAttachments: (message.attachments?.length ?? 0) > 0,
      });
      if (!handled) {
        return false;
      }

      const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: instanceInfo.driverKind,
          providerInstanceId: instanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provider-sign-out"),
        threadId: thread.id,
        activity: {
          id: yield* serverEventId(),
          tone: "info",
          kind: "provider.auth.signed-out",
          summary: "Provider signed out",
          payload: { providerInstanceId: instanceId },
          turnId: null,
          createdAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      return true;
    }).pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))));
    if (authCommandHandled) {
      return;
    }

    yield* ensureThreadWorktree(thread);

    const isCompactCommand = isCompactCommandMessage(message);
    if (!hasOtherUserMessages && !isCompactCommand) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: assistantCitationsToPlainText(message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (
        thread.titleState?.source !== "manual" &&
        canReplaceThreadTitle(thread.title, event.payload.titleSeed)
      ) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          expectedTitle: thread.title,
          expectedVersion: thread.titleState?.version ?? null,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    let compactionSessionEnsured = false;
    const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      if (!compactionSessionEnsured) {
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() => appendTurnStartFailure("Context compaction failed", detail)),
          Effect.asVoid,
        );
      }
      return appendTurnStartFailure("Context compaction failed", detail).pipe(
        Effect.ensuring(
          restoreCompaction(event.payload.threadId).pipe(
            Effect.catchCause((restoreCause) =>
              Effect.logWarning("failed to restore provider session after compaction failure", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(restoreCause),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    };
    const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
      handleCompactionFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover compaction failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );
    if (isCompactCommand) {
      if (!hasOtherUserMessages) {
        return yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId) ||
        latestThread?.session?.status === "starting" ||
        latestThread?.session?.status === "running"
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        return;
      }
      compactingThreadIds.add(event.payload.threadId);
      const clearCompacting = Effect.sync(
        () => void compactingThreadIds.delete(event.payload.threadId),
      );
      yield* Effect.gen(function* () {
        yield* ensureSessionForThread(event.payload.threadId, event.payload.createdAt, {
          ...(event.payload.modelSelection === undefined
            ? {}
            : { modelSelection: event.payload.modelSelection }),
          ...(event.payload.interactionMode === undefined
            ? {}
            : { interactionMode: event.payload.interactionMode }),
          ...(event.payload.delegationConfigFingerprint === undefined
            ? {}
            : {
                delegationConfigFingerprint: event.payload.delegationConfigFingerprint,
              }),
          pendingTurnStart: true,
        });
        compactionSessionEnsured = true;
        if (event.payload.modelSelection !== undefined) {
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        yield* providerService.compactThread(
          event.payload.threadId,
          event.payload.modelSelection,
          event.payload.messageId,
        );
      }).pipe(
        Effect.andThen(restoreCompaction(event.payload.threadId, true)),
        Effect.andThen(clearCompacting),
        Effect.andThen(resumeTurnsAfterCompaction(event.payload.threadId)),
        Effect.catchCause((cause) =>
          recoverCompactionFailure(cause).pipe(
            Effect.ensuring(clearCompacting),
            Effect.andThen(
              cancelTurnsAfterCompaction(
                event.payload.threadId,
                "Context compaction failed. Send this message again to continue.",
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return;
    }
    if (
      !resumed &&
      (compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId))
    ) {
      const queued = turnsAfterCompaction.get(event.payload.threadId) ?? [];
      queued.push(event);
      turnsAfterCompaction.set(event.payload.threadId, queued);
      return;
    }
    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      currentMessageId: event.payload.messageId,
      followUpBehavior: effectiveFollowUp,
      messageText: projectComposerContextForProvider({
        text: message.text,
        records: message.context?.records ?? [],
      }),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      ...(event.payload.delegationConfigFingerprint === undefined
        ? {}
        : { delegationConfigFingerprint: event.payload.delegationConfigFingerprint }),
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    if (event.payload.delegationConfigFingerprint !== undefined) {
      const providerBound = yield* appendDelegationProviderBound({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        providerConfigFingerprint: event.payload.delegationConfigFingerprint,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(false))),
      );
      if (!providerBound) return;
      // Claim before send: a failed claim records the failure and never
      // sends, so every provider-side turn has a persisted claim behind it.
      const sendClaimed = yield* appendTurnSendClaim({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(false))),
      );
      if (!sendClaimed) return;
    }

    const send = providerService
      .sendTurn(sendTurnRequest.value.request)
      .pipe(
        Effect.tap(() =>
          appendArchitectureReviewWakeMarker({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            createdAt: event.payload.createdAt,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("review wake delivery marker could not be appended", {
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
        Effect.tap(() =>
          appendWakeDeliveryMarker({
            threadId: event.payload.threadId,
            wakeMessageIds: sendTurnRequest.value.wakeMessageIds,
            createdAt: event.payload.createdAt,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("delegation wake delivery marker could not be appended", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
        Effect.tap(() =>
          appendArchitecturePublishWakeMarker({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            createdAt: event.payload.createdAt,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("publish wake delivery marker could not be appended", {
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.asVoid, Effect.catchCause(recoverTurnStartFailure));
    // The forked send settles `sent` from here on, so drop the entry the post-processing hook uses.
    if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
    yield* send.pipe(
      Effect.ensuring(resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    const cancellationIntent = (yield* loadDelegationActivities(event.payload.threadId)).findLast(
      (activity) =>
        activity.kind === DELEGATION_CANCEL_REQUESTED_ACTIVITY &&
        Predicate.isObject(activity.payload) &&
        typeof activity.payload.delegatedMessageId === "string" &&
        ((event.payload.pendingMessageId !== undefined &&
          activity.payload.delegatedMessageId === event.payload.pendingMessageId) ||
          (event.payload.turnId !== undefined &&
            activity.payload.delegatedTurnId === event.payload.turnId)),
    );
    const delegatedMessageId =
      cancellationIntent !== undefined && Predicate.isObject(cancellationIntent.payload)
        ? MessageId.make(String(cancellationIntent.payload.delegatedMessageId))
        : undefined;
    const delegatedTurnId =
      event.payload.turnId ??
      (cancellationIntent !== undefined &&
      Predicate.isObject(cancellationIntent.payload) &&
      typeof cancellationIntent.payload.delegatedTurnId === "string"
        ? TurnId.make(cancellationIntent.payload.delegatedTurnId)
        : null);
    const delegatedCancellation = delegatedMessageId !== undefined;
    if (
      event.payload.turnId !== undefined &&
      session?.activeTurnId !== event.payload.turnId &&
      !delegatedCancellation
    ) {
      return;
    }
    if (event.payload.pendingMessageId !== undefined && session?.activeTurnId != null) {
      return;
    }
    yield* cancelTurnsAfterCompaction(
      event.payload.threadId,
      "Context compaction was interrupted. Send this message again to continue.",
    );
    if (!session || session.status === "stopped") {
      if (delegatedCancellation && delegatedMessageId !== undefined) {
        return yield* appendDelegationCancelled({
          threadId: event.payload.threadId,
          messageId: delegatedMessageId,
          turnId: delegatedTurnId,
          createdAt: event.payload.createdAt,
          reason: delegatedTurnId === null ? "start-suppressed" : "provider-not-active",
        });
      }
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    if (delegatedCancellation && delegatedMessageId !== undefined) {
      return yield* providerService.interruptTurn({ threadId: event.payload.threadId }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            return appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail: formatFailureDetail(cause),
              turnId: delegatedTurnId,
              createdAt: event.payload.createdAt,
              ...(event.commandId === null ? {} : { requestId: event.commandId }),
            });
          },
          onSuccess: () =>
            appendDelegationCancelled({
              threadId: event.payload.threadId,
              messageId: delegatedMessageId,
              turnId: delegatedTurnId,
              createdAt: event.payload.createdAt,
              reason: "provider-interrupted",
            }),
        }),
      );
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          ...(event.payload.attachmentsByQuestionId
            ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
            : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    const wasCompacting = compactingThreadIds.has(thread.id);
    stoppingThreadIds.add(thread.id);
    const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(thread.id));
    yield* cancelTurnsAfterCompaction(
      thread.id,
      "The session was stopped during context compaction. Send this message again to continue.",
    ).pipe(
      Effect.andThen(
        thread.session && thread.session.status !== "stopped"
          ? providerService.stopSession({ threadId: thread.id })
          : Effect.void,
      ),
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const detail = formatFailureDetail(cause);
          return Effect.sync(() => {
            stoppingThreadIds.delete(thread.id);
            return wasCompacting && !compactingThreadIds.has(thread.id);
          }).pipe(
            Effect.flatMap((compactionSettled) =>
              compactionSettled ? restoreCompaction(thread.id) : Effect.void,
            ),
            Effect.andThen(
              appendProviderFailureActivity({
                threadId: thread.id,
                kind: "provider.session.stop.failed",
                summary: "Provider session stop failed",
                detail,
                turnId: null,
                createdAt: now,
              }),
            ),
          );
        },
        onSuccess: () =>
          setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "stopped",
              providerName: thread.session?.providerName ?? null,
              ...(thread.session?.providerInstanceId !== undefined
                ? { providerInstanceId: thread.session.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
              activeTurnId: null,
              lastError: thread.session?.lastError ?? null,
              updatedAt: now,
            },
            createdAt: now,
          }),
      }),
      Effect.ensuring(clearStopping),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        if (event.payload.modelSelection !== undefined) {
          threadMetadataModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        if (event.payload.regenerateTitle) yield* threadTitleRegenerationWorker.enqueue(event);
        else if (event.payload.titleState?.needsRefinement)
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.session-set":
        if (event.payload.session.status === "ready")
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const modelSelection =
          threadMetadataModelSelections.get(event.payload.threadId) ??
          threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          modelSelection !== undefined ? { modelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.session == null ||
          thread.value.session.status === "stopped"
        ) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      // A replay that returned before forking its send still holds its entry; settle it so
      // the compaction queue moves on. Forked sends drop the entry first and settle it themselves.
      Effect.ensuring(
        Effect.suspend(() => {
          const resumed = event.commandId !== null && resumedTurnStarts.get(event.commandId);
          return resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void;
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const pendingTitles = yield* findPendingThreadTitles().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to find pending thread titles", {
          failureKind: Cause.hasDies(cause) ? "defect" : "failure",
          reasonCount: cause.reasons.length,
        }).pipe(Effect.as({ interruptedRegenerations: [], refinementThreadIds: [] }));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" &&
          (event.payload.modelSelection !== undefined ||
            event.payload.regenerateTitle === true ||
            event.payload.titleState?.needsRefinement === true)) ||
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));

    // Follow-up receipts and start requests are durable, but this hot stream
    // does not replay events committed before the reactor subscribed. Recover
    // per message, in log order: user messages keep turnId null after their
    // turn finishes, so the message check alone re-bills completed work.
    // A failed or claimed request never runs again; a claim without a
    // recorded turn is uncertain and gets an explicit diagnostic instead.
    // Group queue candidates per thread: one complete detail read per
    // thread, latest event per message wins (a compaction replay supersedes
    // its original; distinct messages keep log order). Markers need the
    // complete scoped read: the default window keeps only the last 500
    // activities, so an older marker would be missed and an already-handled
    // prompt replayed.
    const queuedByThread = new Map<
      string,
      {
        readonly threadId: ThreadId;
        readonly byMessage: Map<
          string,
          Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>
        >;
      }
    >();
    // A failed scan leaves a partial map behind; deciding on it could
    // bill for a request a later unread event already handled.
    const scanSucceeded = yield* Stream.runForEach(
      orchestrationEngine.readPendingDelegatedTurnStarts(),
      (event) =>
        Effect.sync(() => {
          if (
            event.type !== "thread.turn-start-requested" ||
            event.payload.followUpBehavior !== "queue" ||
            event.payload.delegationConfigFingerprint === undefined
          ) {
            return;
          }
          const key = String(event.payload.threadId);
          const queued = queuedByThread.get(key) ?? {
            threadId: event.payload.threadId,
            byMessage: new Map<
              string,
              Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>
            >(),
          };
          queued.byMessage.set(String(event.payload.messageId), event);
          queuedByThread.set(key, queued);
        }),
    ).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("provider command reactor failed to recover queued turn starts", {
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (scanSucceeded) {
      for (const queued of queuedByThread.values()) {
        const detail = yield* projectionSnapshotQuery
          .getThreadDetailById(queued.threadId, {
            activityKinds: [
              "provider.turn.start.failed",
              TURN_SEND_CLAIMED_ACTIVITY,
              TURN_SEND_UNCERTAIN_ACTIVITY,
              DELEGATION_PROVIDER_BOUND_ACTIVITY,
            ],
            activityHistory: "complete",
          })
          .pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.interrupt;
              }
              return Effect.logWarning(
                "provider command reactor skips queued turn starts with unreadable history",
                {
                  threadId: queued.threadId,
                  cause: Cause.pretty(cause),
                },
              ).pipe(Effect.as(Option.none()));
            }),
          );
        if (Option.isNone(detail)) continue;
        const ordered = [...queued.byMessage.values()].sort(
          (left, right) => left.sequence - right.sequence,
        );
        for (const event of ordered) {
          const message = detail.value.messages.find(
            (candidate) => candidate.id === event.payload.messageId,
          );
          const markers = readQueuedTurnSendMarkers(
            detail.value.activities,
            event.payload.messageId,
          );
          if (markers.hasFailed) continue;
          if (markers.hasClaim || markers.hasLegacyBound) {
            yield* maybeFlagUncertainTurnSend({
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              hasUncertainDiagnostic: markers.hasUncertainDiagnostic,
              createdAt: event.payload.createdAt,
            }).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return Effect.interrupt;
                }
                return Effect.logWarning(
                  "provider command reactor failed to flag uncertain turn send",
                  {
                    threadId: event.payload.threadId,
                    messageId: event.payload.messageId,
                    cause: Cause.pretty(cause),
                  },
                );
              }),
            );
            continue;
          }
          if (!shouldRecoverQueuedTurnStart(message, markers.hasFailed)) {
            continue;
          }
          yield* worker.enqueue(event);
        }
      }
    }

    // Earlier events do not replay. Clear interrupted requests by their captured
    // IDs, then schedule persisted refinements after subscribing to their events.
    const recoverTitles = clearInterruptedThreadTitleRegenerations(
      pendingTitles.interruptedRegenerations,
    ).pipe(
      Effect.andThen(
        Effect.forEach(pendingTitles.refinementThreadIds, maybeRefineThreadTitle, {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to recover pending thread titles",
          {
            failureKind: Cause.hasDies(cause) ? "defect" : "failure",
            reasonCount: cause.reasons.length,
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* recoverTitles;
    } else {
      yield* forkParked(recoverTitles);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);

/**
 * Message-level recovery check. Necessary but not sufficient: user messages
 * keep turnId null after their turn finishes, so this alone re-bills
 * completed work. Combine with the per-message send markers from
 * readQueuedTurnSendMarkers: failed or claimed requests never run again.
 */
export function shouldRecoverQueuedTurnStart(
  message: { readonly role: string; readonly turnId: unknown } | undefined,
  hasStartFailed: boolean,
): boolean {
  return message?.role === "user" && message.turnId === null && !hasStartFailed;
}

export type QueuedTurnSendMarkers = {
  readonly hasFailed: boolean;
  readonly hasClaim: boolean;
  readonly hasLegacyBound: boolean;
  readonly hasUncertainDiagnostic: boolean;
};

/**
 * Per-message send evidence for one queued turn start. A claim means the
 * reactor already attempted this exact send; a legacy provider binding
 * means a pre-claim send did. Without a recorded turn either attempt is
 * uncertain (likely a crash before the provider accepted it).
 */
export function readQueuedTurnSendMarkers(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  messageId: MessageId,
): QueuedTurnSendMarkers {
  let hasFailed = false;
  let hasClaim = false;
  let hasLegacyBound = false;
  let hasUncertainDiagnostic = false;
  for (const activity of activities) {
    if (!Predicate.isObject(activity.payload)) {
      continue;
    }
    if (activity.payload.requestId === messageId) {
      if (activity.kind === "provider.turn.start.failed") {
        hasFailed = true;
      } else if (activity.kind === TURN_SEND_CLAIMED_ACTIVITY) {
        hasClaim = true;
      } else if (activity.kind === TURN_SEND_UNCERTAIN_ACTIVITY) {
        hasUncertainDiagnostic = true;
      }
      continue;
    }
    if (
      activity.kind === DELEGATION_PROVIDER_BOUND_ACTIVITY &&
      activity.payload.delegatedMessageId === messageId
    ) {
      hasLegacyBound = true;
    }
  }
  return { hasFailed, hasClaim, hasLegacyBound, hasUncertainDiagnostic };
}

export const __testing = {
  resolveCrossDriverHandoff,
  buildWakeDelivery,
  shouldRecoverQueuedTurnStart,
  readQueuedTurnSendMarkers,
};
