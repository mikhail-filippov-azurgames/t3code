/**
 * Mail tasks for the lead and its participants: the task team, letters between
 * the lead and members, and the route chosen for each member. Launch, delivery
 * and wake belong to the next slice, so this service records state only.
 */
import {
  isAcceleratedModel,
  NormalServicePolicy,
  RoutingPolicyService,
  type RoutingSkippedCandidate,
  routingCandidateModelSelection,
} from "@t3tools/ft3-policies/routing";
import {
  ROUTING_ROLES,
  type RoutingLevel,
  type RoutingRoleId,
} from "@t3tools/ft3-policies/routingPolicy";
import { FeatureGate } from "@t3tools/ft3-policies/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ModelSelection } from "@t3tools/contracts";
import { PlanGate, PlanGateError, type PlanError } from "@t3tools/ft3-board/planning";
import type { PlanCitation, PlanPhase } from "@t3tools/ft3-board/planning-contracts";
import type {
  MailDelivery,
  MailIsolation,
  MailLetter,
  MailLetterKind,
  MailLevel,
  MailMember,
  MailOutcome,
  MailRound,
  MailRoundKind,
  MailTask,
  MailTimelineEntry,
} from "./contracts.ts";
import { applyClassification, effectiveLetterKind, MailKindClassifier } from "./classifier.ts";
import { MailSettingsService } from "./settings.ts";
import { projectIdOfMailTask } from "./projectContext.ts";
import {
  MailRepository,
  type MailIdempotencyConflict,
  type MailMemberRouteInput,
  type MailRepositoryError,
  type TimeoutNoticeLetter,
} from "./repository.ts";
import { MailParticipantLauncher, type MailParticipantLaunchInput } from "./participantLauncher.ts";

const encodeModelSelectionJson = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const decodeModelOverride = Schema.decodeEffect(ModelSelection);
const DEFAULT_RESPONSE_BUDGET_SECONDS = 1800;
const MIN_RESPONSE_BUDGET_SECONDS = 60;
const MAX_RESPONSE_BUDGET_SECONDS = 86400;
const ROUTING_UNAVAILABLE = "The routing policy is not applied, so no participant can be routed.";
const MAX_HUMAN_INSTRUCTION_LENGTH = 4096;

export const MailServiceErrorCode = Schema.Literals([
  "mail_disabled",
  "task_not_found",
  "card_not_found",
  "task_closed",
  "member_closed",
  "letter_not_found",
  "address_denied",
  "kind_denied",
  "kind_not_disputed",
  "invalid_role",
  "capability_denied",
  "human_instruction_required",
  "model_unavailable",
  "idempotency_conflict",
  "invalid_request",
  "plan_not_found",
  "plan_transition_invalid",
  "plan_review_rounds_exhausted",
  "plan_not_accepted",
  "plan_changed",
  "plan_phase_required",
  "plan_phase_invalid",
  "plan_step_unknown",
  "planning_disabled",
]);
export type MailServiceErrorCode = typeof MailServiceErrorCode.Type;

export class MailServiceError extends Schema.TaggedError<MailServiceError>()("MailServiceError", {
  code: MailServiceErrorCode,
  reason: Schema.String,
}) {
  override get message() {
    return `Mail ${this.code}: ${this.reason}`;
  }
}

export type MailSenderKind =
  | { readonly kind: "system" }
  | { readonly kind: "lead" }
  | { readonly kind: "participant"; readonly roleId: string };

export type MailTargetKind = "human" | "lead" | "participant";

const LEAD_TO_PARTICIPANT_KINDS: ReadonlyArray<MailLetterKind> = [
  "request",
  "answer",
  "question",
  "info",
];
const PARTICIPANT_TO_LEAD_KINDS: ReadonlyArray<MailLetterKind> = [
  "answer",
  "question",
  "blocked",
  "info",
];
const CONSULTANT_REVIEW_KINDS: ReadonlyArray<MailLetterKind> = ["approve", "changes"];
const CONSULTANT_REVIEW_ROLES: ReadonlyArray<string> = ["architect", "review"];

/** Wake reasons; an urgent letter's wake steers the participant instead of queueing. */
export const MAIL_LETTER_WAKE_REASON = "mail-letter";
export const MAIL_URGENT_LETTER_WAKE_REASON = "mail-letter-urgent";

/**
 * Who may send which letter kind to whom. Participants never send `request`:
 * only the lead dispatches work. `approve` and `changes` are architect and review answers.
 */
export const mailKindAllowed = (
  sender: MailSenderKind,
  target: MailTargetKind,
  kind: MailLetterKind,
): boolean => {
  switch (sender.kind) {
    case "system":
      return target === "lead" && (kind === "blocked" || kind === "info");
    case "lead":
      return (
        target === "human" || (target === "participant" && LEAD_TO_PARTICIPANT_KINDS.includes(kind))
      );
    case "participant":
      return (
        target === "lead" &&
        (PARTICIPANT_TO_LEAD_KINDS.includes(kind) ||
          (CONSULTANT_REVIEW_ROLES.includes(sender.roleId) &&
            CONSULTANT_REVIEW_KINDS.includes(kind)))
      );
  }
};

export interface MailModelOverride {
  readonly modelSelection: ModelSelection;
  readonly humanInstruction: string;
}

export interface MailMemberRequest {
  readonly role: string;
  readonly specialization?: string | null;
  readonly level?: MailLevel | null;
  readonly responseBudgetSeconds?: number | null;
  readonly documentsWrite?: boolean;
  /** Compose override: runs on this model with no routing fallback. */
  readonly modelOverride?: MailModelOverride | null;
}

export interface SetMemberModelInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly memberId: string;
  readonly modelSelection: ModelSelection;
  readonly humanInstruction: string;
  readonly clientRequestId: string;
}

export interface CreateMailTaskInput {
  readonly callerThreadId: string;
  readonly clientRequestId: string;
  readonly title: string;
  readonly brief: string;
  readonly level: MailLevel;
  readonly cardId?: string | null;
  readonly isolation?: MailIsolation | null;
  readonly runtimeMode?: string | null;
  readonly interactionMode?: string | null;
  readonly members: ReadonlyArray<MailMemberRequest>;
}

/** The route a member could not get: the cell asked for, and why each candidate was skipped. */
export interface MailNoCandidate {
  readonly role: RoutingRoleId;
  readonly level: RoutingLevel;
  readonly skipped: ReadonlyArray<RoutingSkippedCandidate>;
}

export interface MailMemberRoute {
  readonly member: MailMember;
  readonly noCandidate: MailNoCandidate | null;
}

export interface MailTaskCreated {
  readonly task: MailTask;
  readonly created: boolean;
  readonly members: ReadonlyArray<MailMemberRoute>;
}

export interface MailPlanSend {
  readonly phase: PlanPhase;
  readonly step?: string | undefined;
  readonly citation?: PlanCitation | undefined;
}

export interface SendMailLetterInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly to: string;
  readonly kind: MailLetterKind;
  readonly body: string;
  readonly replyToLetterId?: string | null;
  readonly clientRequestId: string;
  readonly plan?: MailPlanSend | undefined;
  /** Lead only: steers an active participant instead of waiting for its turn to end. */
  readonly urgent?: boolean | undefined;
}

export interface MailLetterNoCandidate extends MailNoCandidate {
  readonly memberId: string;
}

export interface MailMemberLaunched {
  readonly memberId: string;
  readonly participantThreadId: string;
}

export interface MailMemberLaunchFailed {
  readonly memberId: string;
  readonly reason: string;
}

export interface SendMailLetterResult {
  readonly letter: MailLetter;
  readonly created: boolean;
  readonly deliveries: ReadonlyArray<MailDelivery>;
  readonly noCandidate: ReadonlyArray<MailLetterNoCandidate>;
  /** Members launched by this letter; a launch failure keeps the delivery pending for a resend. */
  readonly launched: ReadonlyArray<MailMemberLaunched>;
  readonly launchFailures: ReadonlyArray<MailMemberLaunchFailed>;
}

export interface CloseMailTaskInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly outcome: MailOutcome;
  readonly summary: string;
}

export interface SetLetterKindInput {
  readonly callerThreadId: string;
  readonly letterId: string;
  readonly kind: MailLetterKind;
  readonly clientRequestId: string;
}

export interface SetLetterKindResult {
  readonly letter: MailLetter;
  /** The kind server transitions use after the decision. */
  readonly effectiveKind: MailLetterKind;
}

export interface OpenMailRoundInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly kind: MailRoundKind;
}

export interface CloseMailRoundInput {
  readonly callerThreadId: string;
  readonly roundId: string;
  readonly outcome: MailOutcome;
}

export interface ReadMailLetterInput {
  readonly callerThreadId: string;
  readonly letterId: string;
}

export interface ReadMailLetterResult {
  readonly letter: MailLetter;
  readonly deliveries: ReadonlyArray<MailDelivery>;
  /** The kind server transitions use for this letter right now. */
  readonly effectiveKind: MailLetterKind;
}

export interface ReadMailTaskInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly beforeLetterId?: string | null;
  readonly limit?: number | null;
}

export interface ReadMailTaskResult {
  readonly task: MailTask;
  readonly members: ReadonlyArray<MailMember>;
  readonly rounds: ReadonlyArray<MailRound>;
  readonly entries: ReadonlyArray<MailTimelineEntry>;
}

export interface ListMailTimelineInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly beforeSequence?: number | null;
  readonly limit?: number | null;
}

export interface TimeoutOverdueDeliveriesInput {
  /** ISO timestamp the scan compares delivery ages against. */
  readonly now: string;
}

export interface TimeoutOverdueDeliveriesResult {
  /** The pending deliveries the scan failed, oldest first. */
  readonly failed: ReadonlyArray<MailDelivery>;
  /** One system letter per task that lost deliveries, oldest task first. */
  readonly letters: ReadonlyArray<MailLetter>;
}

export interface SettleMailMemberInput {
  readonly memberId: string;
  /** The terminal participant-thread status that settled the member. */
  readonly settledAs: string;
  readonly at: string;
}

export interface SettleMailMemberResult {
  readonly member: MailMember;
  /** The pending deliveries this settle failed, oldest first. */
  readonly failed: ReadonlyArray<MailDelivery>;
  /** The system letter to the lead; null when nothing was stranded. */
  readonly letter: MailLetter | null;
}

/** The applied policy snapshot as JSON, and the board card that keeps it for a task that belongs to one. */
export class MailPolicyEvidence extends Context.Service<
  MailPolicyEvidence,
  {
    readonly snapshotJson: Effect.Effect<string>;
    /** The lead thread that owns the board card, or null when no such card exists. */
    readonly cardOwnerThreadId: (cardId: string) => Effect.Effect<string | null>;
    readonly recordCardSnapshot: (input: {
      readonly cardId: string;
      readonly snapshotJson: string;
    }) => Effect.Effect<void>;
  }
>()("@t3tools/ft3-mail/service/MailPolicyEvidence") {}

interface NormalizedMember {
  readonly roleId: RoutingRoleId;
  readonly specialization: string | null;
  readonly level: MailLevel | null;
  readonly responseBudgetSeconds: number;
  readonly documentsWrite: boolean;
  readonly modelOverrideJson: string | null;
  readonly humanInstruction: string | null;
}

type Recipient =
  | { readonly kind: "human" }
  | { readonly kind: "lead" }
  | { readonly kind: "role"; readonly role: string; readonly specialization: string | null };

interface MailTarget {
  readonly target: MailTargetKind;
  readonly recipient: string;
  readonly memberId: string | null;
  readonly participantThreadId: string | null;
  readonly member: MailMember | null;
}

const refuse = (code: MailServiceErrorCode, reason: string) =>
  new MailServiceError({ code, reason });

const routingRoleOf = (role: string): RoutingRoleId | null =>
  (ROUTING_ROLES as ReadonlyArray<string>).includes(role) ? (role as RoutingRoleId) : null;

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const parseRecipient = (to: string): Recipient | null => {
  if (to === "human") return { kind: "human" };
  if (to === "lead") return { kind: "lead" };
  const match = /^role:([a-z-]+)(?:\/(.+))?$/.exec(to);
  if (match === null) return null;
  const [, role = "", specialization = ""] = match;
  const trimmed = specialization.trim();
  return { kind: "role", role, specialization: trimmed === "" ? null : trimmed };
};

const canonicalRecipient = (recipient: Recipient): string =>
  recipient.kind === "role"
    ? `role:${recipient.role}${recipient.specialization === null ? "" : `/${recipient.specialization}`}`
    : recipient.kind;

const senderOf = (
  task: MailTask,
  members: ReadonlyArray<MailMember>,
  callerThreadId: string,
): MailSenderKind | null => {
  if (callerThreadId === task.createdByThreadId) return { kind: "lead" };
  const member = members.find((candidate) => candidate.participantThreadId === callerThreadId);
  return member === undefined ? null : { kind: "participant", roleId: member.roleId };
};

export class MailService extends Context.Service<
  MailService,
  {
    readonly createTask: (
      input: CreateMailTaskInput,
    ) => Effect.Effect<MailTaskCreated, MailServiceError | MailRepositoryError>;
    /**
     * Lead-only mid-task override on the same thread: the member's next
     * dispatch runs on the new model, the current run is not interrupted.
     */
    readonly setMemberModel: (
      input: SetMemberModelInput,
    ) => Effect.Effect<MailMember, MailServiceError | MailRepositoryError>;
    readonly sendLetter: (
      input: SendMailLetterInput,
    ) => Effect.Effect<SendMailLetterResult, MailServiceError | MailRepositoryError>;
    /**
     * The lead decision on a disputed kind (design §9.4): transitions are
     * recalculated from the decision and one training feedback row is written.
     */
    readonly setLetterKind: (
      input: SetLetterKindInput,
    ) => Effect.Effect<SetLetterKindResult, MailServiceError | MailRepositoryError>;
    /** Opens a discussion round inside a task; planning drives these per review pass. */
    readonly openRound: (
      input: OpenMailRoundInput,
    ) => Effect.Effect<MailRound, MailServiceError | MailRepositoryError>;
    readonly closeRound: (
      input: CloseMailRoundInput,
    ) => Effect.Effect<MailRound, MailServiceError | MailRepositoryError>;
    /** A full letter; while mail is on, reading marks the caller's own delivered delivery read. */
    readonly readLetter: (
      input: ReadMailLetterInput,
    ) => Effect.Effect<ReadMailLetterResult, MailServiceError | MailRepositoryError>;
    /** The task, its members and rounds, and the newest-first letter timeline. */
    readonly readTask: (
      input: ReadMailTaskInput,
    ) => Effect.Effect<ReadMailTaskResult, MailServiceError | MailRepositoryError>;
    readonly listTimeline: (
      input: ListMailTimelineInput,
    ) => Effect.Effect<ReadonlyArray<MailTimelineEntry>, MailServiceError | MailRepositoryError>;
    /**
     * Fails pending deliveries older than the member budget (or the task
     * default) and tells each affected lead once. Members stay active: a late
     * answer still lands, but on a failed delivery.
     */
    readonly timeoutOverdueDeliveries: (
      input: TimeoutOverdueDeliveriesInput,
    ) => Effect.Effect<
      TimeoutOverdueDeliveriesResult,
      MailServiceError | MailRepositoryError | MailIdempotencyConflict
    >;
    readonly closeTask: (
      input: CloseMailTaskInput,
    ) => Effect.Effect<MailTask, MailServiceError | MailRepositoryError>;
    /**
     * Closes a settled member, fails its pending deliveries with the reason and
     * tells the lead with one system letter. Every step is idempotent, so a
     * retried settle heals instead of duplicating.
     */
    readonly settleMember: (
      input: SettleMailMemberInput,
    ) => Effect.Effect<
      SettleMailMemberResult | null,
      MailRepositoryError | MailIdempotencyConflict
    >;
    /** Purges closed tasks older than the cutoff, with their planner claims settled first. */
    readonly purgeFinishedTasks: (input: {
      readonly before: string;
      readonly limit: number;
    }) => Effect.Effect<number, MailServiceError | MailRepositoryError>;
  }
>()("@t3tools/ft3-mail/service/MailService") {}

const make = Effect.gen(function* () {
  const repository = yield* MailRepository;
  const routing = yield* RoutingPolicyService;
  const gate = yield* FeatureGate;
  const crypto = yield* Crypto.Crypto;
  const evidence = yield* MailPolicyEvidence;
  const launcher = yield* MailParticipantLauncher;
  const classifier = yield* MailKindClassifier;
  const mailSettings = yield* MailSettingsService;
  const normalService = yield* NormalServicePolicy;
  const planGate = yield* PlanGate;

  const requireMailForTask = Effect.fn("MailService.requireMailForTask")(function* (
    task: Pick<MailTask, "createdByThreadId" | "cardId">,
  ) {
    const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(task));
    return yield* gate
      .require("mail", projectId)
      .pipe(
        Effect.mapError(
          (error) => new MailServiceError({ code: "mail_disabled", reason: error.message }),
        ),
      );
  });

  const requireMailForEnvironment = Effect.logDebug(
    "Mail feature check has no project context; using environment setting",
  ).pipe(
    Effect.andThen(gate.require("mail")),
    Effect.mapError(
      (error) => new MailServiceError({ code: "mail_disabled", reason: error.message }),
    ),
  );

  const requirePlanningForTask = Effect.fn("MailService.requirePlanningForTask")(function* (
    task: Pick<MailTask, "createdByThreadId" | "cardId">,
  ) {
    const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(task));
    return yield* gate
      .require("planning", projectId)
      .pipe(
        Effect.mapError(
          (error) => new MailServiceError({ code: "planning_disabled", reason: error.message }),
        ),
      );
  });

  const planFailure = (failure: PlanGateError | PlanError): MailServiceError => {
    if (failure._tag === "PlanGateError") {
      return new MailServiceError({ code: failure.code, reason: failure.message });
    }
    switch (failure.code) {
      case "plan_not_found":
        return new MailServiceError({ code: "plan_not_found", reason: failure.message });
      case "plan_transition_invalid":
        return new MailServiceError({ code: "plan_transition_invalid", reason: failure.message });
      case "plan_review_rounds_exhausted":
        return new MailServiceError({
          code: "plan_review_rounds_exhausted",
          reason: failure.message,
        });
      case "planning_disabled":
        return new MailServiceError({ code: "planning_disabled", reason: failure.message });
      case "plan_document_failed":
      case "plan_store_failed":
        return new MailServiceError({ code: "invalid_request", reason: failure.message });
      default:
        return new MailServiceError({ code: "invalid_request", reason: failure.message });
    }
  };

  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fingerprintOf = (value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
      .pipe(Effect.map(hexOf), Effect.orDie);

  const requireTask = Effect.fn("MailService.requireTask")(function* (taskId: string) {
    const task = yield* repository.getTask(taskId);
    if (task === null)
      return yield* refuse("task_not_found", `Mail task "${taskId}" was not found.`);
    return task;
  });

  const requireMailTask = Effect.fn("MailService.requireMailTask")(function* (taskId: string) {
    const task = yield* repository.getTask(taskId);
    if (task === null) {
      yield* requireMailForEnvironment;
      return yield* refuse("task_not_found", `Mail task "${taskId}" was not found.`);
    }
    yield* requireMailForTask(task);
    return task;
  });

  const requireRoutingRole = Effect.fn("MailService.requireRoutingRole")(function* (role: string) {
    const roleId = routingRoleOf(role);
    if (roleId === null)
      return yield* refuse(
        "invalid_role",
        `Role "${role}" is not a mail participant role. Use one of: ${ROUTING_ROLES.join(", ")}.`,
      );
    return roleId;
  });

  // Resolves without recording: replays and letters read the route the policy gives now.
  const noCandidateFor = Effect.fn("MailService.noCandidateFor")(function* (
    role: string,
    level: MailLevel,
  ) {
    const roleId = yield* requireRoutingRole(role);
    const resolution = yield* routing.resolve({ role: roleId, level });
    if (resolution === null) return yield* refuse("mail_disabled", ROUTING_UNAVAILABLE);
    return resolution.candidates.length === 0
      ? { role: roleId, level, skipped: resolution.skipped }
      : null;
  });

  // Chooses the route of a new member; the usage row is keyed by the member id.
  const selectRoute = Effect.fn("MailService.selectRoute")(function* (
    memberId: string,
    role: RoutingRoleId,
    level: MailLevel,
  ) {
    const selection = yield* routing.select({ role, level, delegationId: memberId });
    if (selection === null) return yield* refuse("mail_disabled", ROUTING_UNAVAILABLE);
    const selected = selection.selected;
    if (selected === null) {
      return {
        route: null,
        noCandidate: { role, level, skipped: selection.skipped } satisfies MailNoCandidate,
      };
    }
    const modelSelectionJson = yield* encodeModelSelectionJson(
      routingCandidateModelSelection(selected),
    ).pipe(Effect.orDie);
    const route: MailMemberRouteInput = {
      alias: selected.alias,
      level: selected.level,
      modelSelectionJson,
      policyRevision: selection.policy.revision,
      policySha256: selection.policy.sha256,
    };
    return { route, noCandidate: null };
  });

  /**
   * Validates one explicit override: the human instruction is required, and the
   * normal-service rule refuses accelerated models and tier options outright,
   * including a human override (design §1). The tier-free selection is stored.
   */
  const normalizeOverride = Effect.fn("MailService.normalizeOverride")(function* (
    override: MailModelOverride | null | undefined,
  ) {
    if (override === null || override === undefined) {
      return { modelOverrideJson: null, humanInstruction: null } as const;
    }
    const decoded = yield* decodeModelOverride(override.modelSelection).pipe(
      Effect.mapError(
        () =>
          new MailServiceError({
            code: "invalid_request",
            reason: "The model override is not a model selection.",
          }),
      ),
    );
    const humanInstruction = override.humanInstruction.trim();
    if (humanInstruction === "") {
      return yield* refuse(
        "human_instruction_required",
        "A model override needs a human instruction.",
      );
    }
    if (humanInstruction.length > MAX_HUMAN_INSTRUCTION_LENGTH) {
      return yield* refuse(
        "invalid_request",
        `A human instruction must be at most ${MAX_HUMAN_INSTRUCTION_LENGTH} characters.`,
      );
    }
    if (isAcceleratedModel(decoded.model)) {
      return yield* refuse(
        "model_unavailable",
        `Model "${decoded.model}" requests an accelerated service tier and cannot run.`,
      );
    }
    const normalized = normalService.normalizeSelection({
      // No driver forcing: an override runs on provider defaults, which are normal.
      driverKind: "",
      instanceId: decoded.instanceId,
      model: decoded.model,
      ...(decoded.options === undefined ? {} : { options: decoded.options }),
    });
    if (normalized.accelerated) {
      return yield* refuse(
        "model_unavailable",
        "A model override must not request an accelerated service tier.",
      );
    }
    // The instance and model are untouched by normalization, so the decoded
    // brands carry over and only the tier-free options are stored.
    const modelOverrideJson = yield* encodeModelSelectionJson({
      instanceId: decoded.instanceId,
      model: decoded.model,
      ...(normalized.selection.options.length === 0
        ? {}
        : { options: [...normalized.selection.options] }),
    }).pipe(Effect.orDie);
    return { modelOverrideJson, humanInstruction };
  });

  const normalizeMembers = Effect.fn("MailService.normalizeMembers")(function* (
    members: ReadonlyArray<MailMemberRequest>,
  ) {
    if (members.length === 0) {
      return yield* refuse("invalid_request", "A mail task needs at least one member.");
    }
    const normalized: NormalizedMember[] = [];
    for (const member of members) {
      const roleId = yield* requireRoutingRole(member.role);
      const documentsWrite = member.documentsWrite === true;
      if (documentsWrite && roleId !== "general") {
        return yield* refuse(
          "capability_denied",
          "documents:write can be granted only to a general participant.",
        );
      }
      const budget = member.responseBudgetSeconds ?? DEFAULT_RESPONSE_BUDGET_SECONDS;
      if (
        !Number.isInteger(budget) ||
        budget < MIN_RESPONSE_BUDGET_SECONDS ||
        budget > MAX_RESPONSE_BUDGET_SECONDS
      ) {
        return yield* refuse(
          "invalid_request",
          `Response budget must be ${MIN_RESPONSE_BUDGET_SECONDS}..${MAX_RESPONSE_BUDGET_SECONDS} seconds.`,
        );
      }
      const override = yield* normalizeOverride(member.modelOverride);
      const specialization = member.specialization?.trim() ?? "";
      normalized.push({
        roleId,
        specialization: specialization === "" ? null : specialization,
        level: member.level ?? null,
        responseBudgetSeconds: budget,
        documentsWrite,
        modelOverrideJson: override.modelOverrideJson,
        humanInstruction: override.humanInstruction,
      });
    }
    return normalized;
  });

  const replayTask = Effect.fn("MailService.replayTask")(function* (
    task: MailTask,
    requestFingerprint: string,
  ) {
    if (task.requestFingerprint !== requestFingerprint) {
      return yield* refuse(
        "idempotency_conflict",
        "This client request was already used for a different mail task payload.",
      );
    }
    const stored = yield* repository.listMembers(task.taskId);
    const members = yield* Effect.forEach(stored, (member) =>
      noCandidateFor(member.roleId, member.level ?? task.level).pipe(
        Effect.map((noCandidate) => ({ member, noCandidate })),
      ),
    );
    return { task, created: false, members } satisfies MailTaskCreated;
  });

  const createTask = Effect.fn("MailService.createTask")(function* (input: CreateMailTaskInput) {
    yield* requireMailForTask({
      createdByThreadId: input.callerThreadId,
      cardId: input.cardId ?? null,
    });
    const title = input.title.trim();
    if (title === "") return yield* refuse("invalid_request", "A mail task needs a title.");
    const members = yield* normalizeMembers(input.members);
    const requestFingerprint = yield* fingerprintOf([
      title,
      input.brief,
      input.level,
      input.cardId ?? null,
      input.isolation ?? null,
      input.runtimeMode ?? null,
      input.interactionMode ?? null,
      members.map((member) => [
        member.roleId,
        member.specialization,
        member.level,
        member.responseBudgetSeconds,
        member.documentsWrite,
        member.modelOverrideJson,
        member.humanInstruction,
      ]),
    ]);
    const existing = yield* repository.getTaskByRequestKey({
      createdByThreadId: input.callerThreadId,
      clientRequestId: input.clientRequestId,
    });
    if (existing !== null) return yield* replayTask(existing, requestFingerprint);
    const cardId = input.cardId ?? null;
    // A card of another lead is refused like a missing one, so its id is not revealed.
    if (cardId !== null && (yield* evidence.cardOwnerThreadId(cardId)) !== input.callerThreadId) {
      return yield* refuse("card_not_found", `Board card "${cardId}" was not found.`);
    }

    const taskId = yield* newId;
    const rows = yield* Effect.forEach(members, (member) =>
      newId.pipe(Effect.map((memberId) => ({ ...member, memberId }))),
    );
    // An overridden member runs on its model with no routing fallback, so no
    // route is recorded for it; every other member is routed as before.
    const routeMember = (
      row: NormalizedMember & { readonly memberId: string },
    ): Effect.Effect<
      { readonly route: MailMemberRouteInput | null; readonly noCandidate: MailNoCandidate | null },
      MailServiceError
    > =>
      row.modelOverrideJson !== null
        ? Effect.succeed({ route: null, noCandidate: null })
        : selectRoute(row.memberId, row.roleId, row.level ?? input.level);
    const routes = yield* Effect.forEach(rows, routeMember);
    const now = yield* nowIso;
    const result = yield* repository
      .createTask({
        taskId,
        title,
        brief: input.brief,
        level: input.level,
        cardId: input.cardId ?? null,
        isolation: input.isolation ?? null,
        runtimeMode: input.runtimeMode ?? null,
        interactionMode: input.interactionMode ?? null,
        responseBudgetSeconds: DEFAULT_RESPONSE_BUDGET_SECONDS,
        createdByThreadId: input.callerThreadId,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        createdAt: now,
      })
      .pipe(
        Effect.catchTags({
          MailIdempotencyConflict: () =>
            refuse(
              "idempotency_conflict",
              "This client request was already used for another payload.",
            ),
        }),
      );
    if (!result.created) return yield* replayTask(result.task, requestFingerprint);

    const stored = yield* Effect.forEach(rows, (row, index) =>
      repository
        .addMember({
          memberId: row.memberId,
          taskId,
          roleId: row.roleId,
          specialization: row.specialization,
          level: row.level,
          responseBudgetSeconds: row.responseBudgetSeconds,
          documentsWrite: row.documentsWrite,
          modelOverrideJson: row.modelOverrideJson,
          humanInstruction: row.humanInstruction,
          participantThreadId: null,
          route: routes[index]?.route ?? null,
          createdAt: now,
        })
        .pipe(
          Effect.map((member) => ({ member, noCandidate: routes[index]?.noCandidate ?? null })),
        ),
    );
    if (cardId !== null) {
      yield* evidence.recordCardSnapshot({
        cardId,
        snapshotJson: yield* evidence.snapshotJson,
      });
    }
    return { task: result.task, created: true, members: stored } satisfies MailTaskCreated;
  });

  const resolveTargets = Effect.fn("MailService.resolveTargets")(function* (
    sender: MailSenderKind,
    recipient: Recipient,
    task: MailTask,
    members: ReadonlyArray<MailMember>,
  ) {
    if (sender.kind === "participant") {
      if (recipient.kind !== "lead") {
        return yield* refuse("address_denied", "A participant can write only to the lead.");
      }
      const lead: MailTarget = {
        target: "lead",
        recipient: "lead",
        memberId: null,
        participantThreadId: task.createdByThreadId,
        member: null,
      };
      return [lead];
    }
    if (recipient.kind === "human") {
      const human: MailTarget = {
        target: "human",
        recipient: "human",
        memberId: null,
        participantThreadId: null,
        member: null,
      };
      return [human];
    }
    if (recipient.kind === "lead") {
      return yield* refuse("address_denied", "The lead cannot write to itself.");
    }
    const roleId = yield* requireRoutingRole(recipient.role);
    const matched = members.filter(
      (member) =>
        member.roleId === roleId &&
        (recipient.specialization === null || member.specialization === recipient.specialization),
    );
    if (matched.length === 0) {
      return yield* refuse("address_denied", `No ${roleId} participant is declared in this task.`);
    }
    const targets: MailTarget[] = matched.map((member) => ({
      target: "participant",
      recipient: `member:${member.memberId}`,
      memberId: member.memberId,
      participantThreadId: member.participantThreadId,
      member,
    }));
    return targets;
  });

  const sendLetter = Effect.fn("MailService.sendLetter")(function* (input: SendMailLetterInput) {
    const task = yield* requireMailTask(input.taskId);
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is closed.`);
    }
    const members = yield* repository.listMembers(task.taskId);
    const sender = senderOf(task, members, input.callerThreadId);
    if (sender === null) {
      return yield* refuse(
        "capability_denied",
        `Thread "${input.callerThreadId}" is not part of mail task "${task.taskId}".`,
      );
    }
    const recipient = parseRecipient(input.to.trim());
    if (recipient === null) {
      return yield* refuse(
        "invalid_request",
        `Recipient "${input.to}" must be human, lead, or role:<role>[/<specialization>].`,
      );
    }
    if (input.urgent === true && sender.kind !== "lead") {
      return yield* refuse("capability_denied", "Only the lead can send an urgent letter.");
    }
    const targets = yield* resolveTargets(sender, recipient, task, members);
    for (const target of targets) {
      if (!mailKindAllowed(sender, target.target, input.kind)) {
        return yield* refuse(
          "kind_denied",
          `A ${sender.kind} cannot send a ${input.kind} letter to the ${target.target}.`,
        );
      }
      if (target.member !== null && target.member.status === "closed") {
        return yield* refuse(
          "member_closed",
          `Member "${target.member.memberId}" is closed and receives no more letters.`,
        );
      }
    }
    const plan = input.plan ?? undefined;
    if (plan !== undefined) {
      yield* requirePlanningForTask(task);
      if (task.cardId === null) {
        return yield* refuse(
          "invalid_request",
          "A plan letter needs a mail task linked to a board card.",
        );
      }
      if (recipient.kind === "role") {
        if (plan.phase === "draft" && recipient.role !== "planner") {
          return yield* refuse(
            "plan_phase_invalid",
            `A draft letter goes to the planner, not to role:${recipient.role}.`,
          );
        }
        if (plan.phase === "review" && recipient.role !== "architect") {
          return yield* refuse(
            "plan_phase_invalid",
            `A review letter goes to architect members, not to role:${recipient.role}.`,
          );
        }
      }
    }
    const replyToLetterId = input.replyToLetterId ?? null;
    if (replyToLetterId !== null) {
      const parent = yield* repository.getLetter(replyToLetterId);
      if (parent === null || parent.taskId !== task.taskId) {
        return yield* refuse(
          "letter_not_found",
          `Letter "${replyToLetterId}" was not found in this task.`,
        );
      }
    }
    const to = canonicalRecipient(recipient);
    // Only participant letters to the lead are classified; the sender kind is
    // always kept on the letter, and a no-op classifier keeps it authoritative.
    const classification =
      sender.kind === "participant" && recipient.kind === "lead"
        ? yield* classifier.classify({
            taskId: task.taskId,
            kind: input.kind,
            body: input.body,
            senderRoleId: sender.roleId,
          })
        : null;
    const classified = applyClassification(
      input.kind,
      classification,
      mailSettings.classifierThreshold,
    );
    // A plan letter's payload joins the fingerprint, so a retry with a changed plan conflicts;
    // plain letters keep the fingerprint they were stored with.
    const planFingerprint =
      plan === undefined
        ? []
        : [
            {
              phase: plan.phase,
              step: plan.step ?? null,
              citation:
                plan.citation === undefined
                  ? null
                  : {
                      planDocId: plan.citation.planDocId,
                      planSha256: plan.citation.planSha256,
                      planStep: plan.citation.planStep ?? null,
                    },
            },
          ];
    const requestFingerprint = yield* fingerprintOf([
      to,
      input.kind,
      input.body,
      replyToLetterId,
      ...planFingerprint,
    ]);
    const letterId = yield* newId;
    const now = yield* nowIso;
    const cardId = task.cardId;
    const plannerAnswer =
      sender.kind === "participant" &&
      sender.roleId === "planner" &&
      recipient.kind === "lead" &&
      input.kind === "answer";
    // The letter, the gate and the plan transition commit together: a refused gate or a
    // failed transition removes the letter, and a replay applies no transition twice.
    const appended = yield* repository.transaction(
      Effect.gen(function* () {
        const result = yield* repository
          .appendLetter({
            letterId,
            taskId: task.taskId,
            senderThreadId: input.callerThreadId,
            recipient: to,
            kind: input.kind,
            body: input.body,
            replyToLetterId,
            sourceLetterId: null,
            planPhase: plan?.phase ?? null,
            planStep: plan?.step ?? plan?.citation?.planStep ?? null,
            planSha256: plan?.citation?.planSha256 ?? null,
            planDocId: plan?.citation?.planDocId ?? null,
            classifierKind: classified.classifierKind,
            classifierConfidence: classified.classifierConfidence,
            kindDisputed: classified.kindDisputed,
            leadKind: null,
            clientRequestId: input.clientRequestId,
            requestFingerprint,
            createdAt: now,
          })
          .pipe(
            Effect.catchTags({
              MailIdempotencyConflict: () =>
                refuse(
                  "idempotency_conflict",
                  "This client request was already used for another letter.",
                ),
            }),
          );
        const senderMemberId =
          sender.kind === "participant"
            ? members.find((member) => member.participantThreadId === input.callerThreadId)
                ?.memberId
            : undefined;
        if (replyToLetterId !== null && senderMemberId !== undefined) {
          const parentDeliveries = yield* repository.listLetterDeliveries(replyToLetterId);
          const own = parentDeliveries.find((delivery) => delivery.memberId === senderMemberId);
          if (own !== undefined) {
            yield* repository.markDeliveryAnswered({ deliveryId: own.deliveryId, at: now });
          }
        }
        if (cardId !== null) {
          const citation =
            plan?.citation === undefined
              ? undefined
              : {
                  planDocId: plan.citation.planDocId,
                  planSha256: plan.citation.planSha256,
                  ...(plan.citation.planStep === undefined
                    ? {}
                    : { planStep: plan.citation.planStep }),
                };
          const memberRoleIds = [
            ...new Set(
              targets.flatMap((target) => (target.member === null ? [] : [target.member.roleId])),
            ),
          ];
          for (const roleId of memberRoleIds) {
            yield* planGate
              .check({
                cardId,
                roleId,
                phase: plan?.phase,
                step: plan?.step,
                citation,
                isolation: task.isolation,
              })
              .pipe(Effect.mapError(planFailure));
          }
        }
        if (result.created && cardId !== null && plan !== undefined) {
          yield* planGate
            .recordPlanLetter({ cardId, phase: plan.phase })
            .pipe(Effect.mapError(planFailure));
        }
        if (result.created && cardId !== null && plannerAnswer) {
          yield* planGate.recordPlannerAnswer({ cardId }).pipe(Effect.mapError(planFailure));
        }
        return result;
      }),
    );
    // The lead's letter starts a threadless member; a repeat reuses the same thread.
    // A member whose route is null gets one when the letter is resent after the
    // policy is fixed; an overridden member launches on its override instead.
    const launched: MailMemberLaunched[] = [];
    const launchFailures: MailMemberLaunchFailed[] = [];
    const launchedThreads = new Map<string, string>();
    if (sender.kind === "lead") {
      for (const target of targets) {
        const member = target.member;
        if (member === null) {
          continue;
        }
        // A card has one planner: the claim decides who launches. A launched planner whose
        // binding was interrupted is bound again here, never launched a second time.
        const plannerCardId = member.roleId === "planner" ? task.cardId : null;
        if (member.participantThreadId !== null) {
          if (plannerCardId !== null) {
            yield* planGate
              .bindPlanner({
                cardId: plannerCardId,
                memberId: member.memberId,
                threadId: member.participantThreadId,
              })
              .pipe(Effect.mapError(planFailure));
            launchedThreads.set(member.memberId, member.participantThreadId);
          }
          continue;
        }
        let current = member;
        if (plannerCardId !== null) {
          const claim = yield* planGate
            .claimPlanner({ cardId: plannerCardId, memberId: current.memberId })
            .pipe(Effect.mapError(planFailure));
          if (claim._tag === "Bound") {
            yield* repository.setParticipantThread({
              memberId: current.memberId,
              participantThreadId: claim.threadId,
              at: yield* nowIso,
            });
            launchedThreads.set(current.memberId, claim.threadId);
            continue;
          }
          if (claim._tag === "Pending") {
            launchFailures.push({
              memberId: current.memberId,
              reason: "the card's planner is still launching; resend the letter",
            });
            continue;
          }
        }
        if (current.modelOverrideJson === null && current.routeModelSelectionJson === null) {
          const retry = yield* selectRoute(
            current.memberId,
            yield* requireRoutingRole(current.roleId),
            current.level ?? task.level,
          );
          if (retry.route !== null) {
            current =
              (yield* repository.setMemberRoute({
                memberId: current.memberId,
                route: retry.route,
                at: yield* nowIso,
              })) ?? current;
          }
        }
        const modelSelectionJson = current.modelOverrideJson ?? current.routeModelSelectionJson;
        if (modelSelectionJson === null) {
          continue;
        }
        const launchInput: MailParticipantLaunchInput = {
          leadThreadId: task.createdByThreadId,
          taskId: task.taskId,
          taskTitle: task.title,
          memberId: current.memberId,
          roleId: current.roleId,
          specialization: current.specialization,
          modelSelectionJson,
          letterId: appended.letter.letterId,
          letterBody: input.body,
          isolation: task.isolation,
        };
        const outcome = yield* launcher.launch(launchInput).pipe(
          Effect.map((threadId) => ({ launched: true, threadId }) as const),
          Effect.catchTags({
            MailLaunchError: (error) =>
              Effect.succeed({ launched: false, reason: error.reason } as const),
          }),
        );
        if (!outcome.launched) {
          launchFailures.push({ memberId: current.memberId, reason: outcome.reason });
          continue;
        }
        yield* repository.setParticipantThread({
          memberId: current.memberId,
          participantThreadId: outcome.threadId,
          at: yield* nowIso,
        });
        launched.push({ memberId: current.memberId, participantThreadId: outcome.threadId });
        launchedThreads.set(current.memberId, outcome.threadId);
        if (plannerCardId !== null) {
          yield* planGate
            .bindPlanner({
              cardId: plannerCardId,
              memberId: current.memberId,
              threadId: outcome.threadId,
            })
            .pipe(Effect.mapError(planFailure));
        }
      }
    }
    // Recording is idempotent per (letter, recipient), so a replay heals a letter whose deliveries never landed.
    const recordedDeliveries = yield* Effect.forEach(targets, (target) =>
      newId.pipe(
        Effect.flatMap((deliveryId) =>
          repository
            .recordDelivery({
              deliveryId,
              taskId: task.taskId,
              letterId: appended.letter.letterId,
              memberId: target.memberId,
              recipient: target.recipient,
              participantThreadId:
                (target.memberId !== null ? launchedThreads.get(target.memberId) : undefined) ??
                target.participantThreadId,
              createdAt: now,
            })
            .pipe(
              Effect.flatMap((recorded) => {
                const launched =
                  target.memberId !== null ? launchedThreads.get(target.memberId) : undefined;
                if (
                  launched === undefined ||
                  recorded.participantThreadId !== null ||
                  recorded.state !== "pending"
                ) {
                  return Effect.succeed(recorded);
                }
                // A resend after the policy was fixed launches the member, but the
                // delivery row already exists without a thread: bind it instead of
                // dropping the launch, so the wake below reaches the thread.
                return repository
                  .bindDeliveryThread({
                    deliveryId: recorded.deliveryId,
                    participantThreadId: launched,
                    at: now,
                  })
                  .pipe(Effect.map((bound) => bound ?? recorded));
              }),
            ),
        ),
      ),
    );
    // A member launched by this letter already received it in its first prompt, so its delivery is
    // delivered and gets no wake; only a pending delivery with a thread is woken.
    const deliveries = yield* Effect.forEach(recordedDeliveries, (delivery) =>
      launched.some((member) => member.memberId === delivery.memberId)
        ? repository
            .markDeliveryDelivered({ deliveryId: delivery.deliveryId, at: now })
            .pipe(Effect.map((marked) => marked ?? delivery))
        : Effect.succeed(delivery),
    );
    // An agent thread gets a durable wake; the reactor drains it and marks the delivery.
    yield* Effect.forEach(
      deliveries.filter(
        (delivery) => delivery.participantThreadId !== null && delivery.state === "pending",
      ),
      (delivery) =>
        repository.recordWake({
          wakeId: `mail:wake:${delivery.deliveryId}`,
          taskId: task.taskId,
          targetThreadId: delivery.participantThreadId ?? "",
          reason: input.urgent === true ? MAIL_URGENT_LETTER_WAKE_REASON : MAIL_LETTER_WAKE_REASON,
          idempotencyKey: `mail:wake:${delivery.deliveryId}`,
          createdAt: now,
        }),
      { discard: true },
    );
    // Overridden members run on their override and never need a route.
    const noCandidate: MailLetterNoCandidate[] = [];
    for (const target of targets) {
      if (target.member === null || target.member.modelOverrideJson !== null) continue;
      const gap = yield* noCandidateFor(target.member.roleId, target.member.level ?? task.level);
      if (gap !== null) noCandidate.push({ memberId: target.member.memberId, ...gap });
    }
    return {
      letter: appended.letter,
      created: appended.created,
      deliveries,
      noCandidate,
      launched,
      launchFailures,
    };
  });

  const setLetterKind = Effect.fn("MailService.setLetterKind")(function* (
    input: SetLetterKindInput,
  ) {
    if (input.clientRequestId.trim() === "") {
      return yield* refuse("invalid_request", "A letter kind decision needs a client request id.");
    }
    const letter = yield* repository.getLetter(input.letterId);
    if (letter === null) {
      yield* requireMailForEnvironment;
      return yield* refuse("letter_not_found", `Letter "${input.letterId}" was not found.`);
    }
    const task = yield* requireMailTask(letter.taskId);
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is closed.`);
    }
    if (task.createdByThreadId !== input.callerThreadId) {
      return yield* refuse("capability_denied", "Only the lead can decide a disputed letter kind.");
    }
    if (!letter.kindDisputed) {
      return yield* refuse(
        "kind_not_disputed",
        `Letter "${letter.letterId}" has no disputed kind to decide.`,
      );
    }
    const now = yield* nowIso;
    const decided = yield* repository.setLetterClassifier({
      letterId: letter.letterId,
      classifierKind: letter.classifierKind,
      classifierConfidence: letter.classifierConfidence,
      kindDisputed: false,
      leadKind: input.kind,
    });
    if (decided === null) {
      return yield* refuse("letter_not_found", `Letter "${letter.letterId}" was not found.`);
    }
    yield* repository.recordKindFeedback({
      letterId: letter.letterId,
      senderKind: letter.kind,
      classifierKind: letter.classifierKind,
      confidence: letter.classifierConfidence,
      leadKind: input.kind,
      classifierVersion: null,
      createdAt: now,
    });
    return { letter: decided, effectiveKind: input.kind } satisfies SetLetterKindResult;
  });

  const requireTaskAccess = Effect.fn("MailService.requireTaskAccess")(function* (
    task: MailTask,
    callerThreadId: string,
  ) {
    if (task.createdByThreadId === callerThreadId) return;
    const members = yield* repository.listMembers(task.taskId);
    const member = members.find((candidate) => candidate.participantThreadId === callerThreadId);
    if (member === undefined) {
      return yield* refuse(
        "capability_denied",
        `Thread "${callerThreadId}" is not part of mail task "${task.taskId}".`,
      );
    }
  });

  // A participant reads only the letters it sent or was delivered; the lead reads the whole task.
  const letterReadableBy = (
    task: MailTask,
    members: ReadonlyArray<MailMember>,
    callerThreadId: string,
    letter: MailLetter,
    deliveries: ReadonlyArray<MailDelivery>,
  ) => {
    if (task.createdByThreadId === callerThreadId || letter.senderThreadId === callerThreadId) {
      return true;
    }
    const member = members.find((candidate) => candidate.participantThreadId === callerThreadId);
    return (
      member !== undefined && deliveries.some((delivery) => delivery.memberId === member.memberId)
    );
  };

  const TIMELINE_DEFAULT_LIMIT = 50;
  const TIMELINE_MAX_LIMIT = 100;

  const requireTimelineLimit = Effect.fn("MailService.requireTimelineLimit")(function* (
    limit: number | null | undefined,
  ) {
    const value = limit ?? TIMELINE_DEFAULT_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > TIMELINE_MAX_LIMIT) {
      return yield* refuse(
        "invalid_request",
        `A timeline limit must be 1..${TIMELINE_MAX_LIMIT} letters.`,
      );
    }
    return value;
  });

  const openRound = Effect.fn("MailService.openRound")(function* (input: OpenMailRoundInput) {
    const task = yield* requireMailTask(input.taskId);
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is closed.`);
    }
    if (task.createdByThreadId !== input.callerThreadId) {
      return yield* refuse("capability_denied", "Only the lead can open a mail round.");
    }
    const rounds = yield* repository.listRounds(task.taskId);
    const roundNumber = rounds.reduce((max, round) => Math.max(max, round.roundNumber), 0) + 1;
    const opened = yield* repository.createRound({
      roundId: yield* newId,
      taskId: task.taskId,
      roundNumber,
      kind: input.kind,
      openedAt: yield* nowIso,
    });
    return opened.round;
  });

  const closeRound = Effect.fn("MailService.closeRound")(function* (input: CloseMailRoundInput) {
    const round = yield* repository.getRound(input.roundId);
    if (round === null) {
      yield* requireMailForEnvironment;
      return yield* refuse("invalid_request", `Round "${input.roundId}" was not found.`);
    }
    const task = yield* requireMailTask(round.taskId);
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is closed.`);
    }
    if (task.createdByThreadId !== input.callerThreadId) {
      return yield* refuse("capability_denied", "Only the lead can close a mail round.");
    }
    const closed = yield* repository.closeRound({
      roundId: round.roundId,
      outcome: input.outcome,
      closedAt: yield* nowIso,
    });
    if (closed === null) {
      return yield* refuse("invalid_request", `Round "${round.roundId}" was not found.`);
    }
    return closed;
  });

  const readLetter = Effect.fn("MailService.readLetter")(function* (input: ReadMailLetterInput) {
    const letter = yield* repository.getLetter(input.letterId);
    if (letter === null) {
      return yield* refuse("letter_not_found", `Letter "${input.letterId}" was not found.`);
    }
    const task = yield* requireTask(letter.taskId);
    yield* requireTaskAccess(task, input.callerThreadId);
    const members = yield* repository.listMembers(task.taskId);
    const addressed = yield* repository.listLetterDeliveries(letter.letterId);
    if (!letterReadableBy(task, members, input.callerThreadId, letter, addressed)) {
      return yield* refuse(
        "capability_denied",
        `Letter "${letter.letterId}" is neither from nor addressed to thread "${input.callerThreadId}".`,
      );
    }
    // Marking a delivery read is a write, so only an enabled mail feature does it.
    const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(task));
    if (
      task.status === "open" &&
      (yield* gate.isEffective("mail", projectId).pipe(Effect.orElseSucceed(() => false)))
    ) {
      const pending = yield* repository.listLetterDeliveries(letter.letterId);
      for (const delivery of pending) {
        if (
          delivery.state === "delivered" &&
          delivery.participantThreadId === input.callerThreadId
        ) {
          yield* repository.markDeliveryRead({
            deliveryId: delivery.deliveryId,
            at: yield* nowIso,
          });
        }
      }
    }
    const deliveries = yield* repository.listLetterDeliveries(letter.letterId);
    return {
      letter,
      deliveries,
      effectiveKind: effectiveLetterKind(letter),
    } satisfies ReadMailLetterResult;
  });

  const readTask = Effect.fn("MailService.readTask")(function* (input: ReadMailTaskInput) {
    const task = yield* requireTask(input.taskId);
    yield* requireTaskAccess(task, input.callerThreadId);
    const limit = yield* requireTimelineLimit(input.limit);
    let beforeSequence: number | undefined;
    if (input.beforeLetterId !== null && input.beforeLetterId !== undefined) {
      const before = yield* repository.getLetter(input.beforeLetterId);
      if (before === null || before.taskId !== task.taskId) {
        return yield* refuse(
          "letter_not_found",
          `Letter "${input.beforeLetterId}" was not found in this task.`,
        );
      }
      beforeSequence = before.sequence;
    }
    const members = yield* repository.listMembers(task.taskId);
    const rounds = yield* repository.listRounds(task.taskId);
    const timeline = yield* repository.listTimeline({
      taskId: task.taskId,
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit,
    });
    const entries = timeline.filter((entry) =>
      letterReadableBy(task, members, input.callerThreadId, entry.letter, entry.deliveries),
    );
    return { task, members, rounds, entries } satisfies ReadMailTaskResult;
  });

  const listTimeline = Effect.fn("MailService.listTimeline")(function* (
    input: ListMailTimelineInput,
  ) {
    // History stays readable while the mail feature is off; task access is the
    // read permission, and every operation below still requires the feature.
    const task = yield* requireTask(input.taskId);
    yield* requireTaskAccess(task, input.callerThreadId);
    const limit = yield* requireTimelineLimit(input.limit);
    return yield* repository.listTimeline({
      taskId: task.taskId,
      ...(input.beforeSequence === null || input.beforeSequence === undefined
        ? {}
        : { beforeSequence: input.beforeSequence }),
      limit,
    });
  });

  const TIMEOUT_CANDIDATE_LIMIT = 500;

  const timeoutOverdueDeliveries = Effect.fn("MailService.timeoutOverdueDeliveries")(function* (
    input: TimeoutOverdueDeliveriesInput,
  ) {
    const nowMs = Date.parse(input.now);
    if (Number.isNaN(nowMs)) {
      return yield* refuse("invalid_request", "The timeout scan needs an ISO timestamp.");
    }
    const candidates = yield* repository.listTimeoutCandidates({
      limit: TIMEOUT_CANDIDATE_LIMIT,
    });
    const overdue = candidates.filter(
      (candidate) =>
        Date.parse(candidate.delivery.createdAt) + candidate.budgetSeconds * 1000 < nowMs,
    );
    const overdueByTask = new Map<string, Array<(typeof overdue)[number]>>();
    for (const candidate of overdue) {
      const candidatesForTask = overdueByTask.get(candidate.delivery.taskId) ?? [];
      candidatesForTask.push(candidate);
      overdueByTask.set(candidate.delivery.taskId, candidatesForTask);
    }
    // The plan is reads only; one repository transaction applies every write, so
    // a crash anywhere retries from scratch with no partial rows.
    const failed: Array<{ readonly deliveryId: string; readonly reason: string }> = [];
    const letters: TimeoutNoticeLetter[] = [];
    for (const [taskId, timedOut] of overdueByTask) {
      const task = yield* repository.getTask(taskId);
      if (task === null || task.status !== "open") continue;
      const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(task));
      if (!(yield* gate.isEffective("mail", projectId).pipe(Effect.orElseSucceed(() => false)))) {
        continue;
      }
      failed.push(
        ...timedOut.map((candidate) => ({
          deliveryId: candidate.delivery.deliveryId,
          reason:
            `The ${candidate.roleId ?? "participant"} did not answer within ` +
            `${candidate.budgetSeconds} seconds.`,
        })),
      );
      const lines = timedOut.map(
        (candidate) =>
          `- ${candidate.roleId ?? "participant"}: 1 unanswered letter (${candidate.delivery.letterId})`,
      );
      const letterIds = timedOut.map((candidate) => candidate.delivery.letterId).toSorted();
      const deliveryId = yield* newId;
      letters.push({
        letterId: yield* newId,
        taskId: task.taskId,
        body:
          `The response budget expired:\n${lines.join("\n")}\n` +
          "The deliveries were marked failed; resend anything the participants still need.",
        sourceLetterId: letterIds[0] ?? null,
        clientRequestId: `mail:member-timeout:${task.taskId}:${input.now}`,
        requestFingerprint: yield* fingerprintOf(["member-timeout", task.taskId, letterIds]),
        deliveryId,
        wakeId: `mail:wake:${deliveryId}`,
        createdAt: input.now,
      });
    }
    const applied = yield* repository.applyTimeoutNotices({
      now: input.now,
      failed,
      letters,
    });
    return {
      failed: [...applied.failed],
      letters: [...applied.letters],
    } satisfies TimeoutOverdueDeliveriesResult;
  });

  const closeTask = Effect.fn("MailService.closeTask")(function* (input: CloseMailTaskInput) {
    const task = yield* requireMailTask(input.taskId);
    if (task.createdByThreadId !== input.callerThreadId) {
      return yield* refuse("capability_denied", "Only the lead can close a mail task.");
    }
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is already closed.`);
    }
    // Closing the task closes its active members: a member otherwise stays active until the lead ends it.
    const closed = yield* repository.closeTask({
      taskId: task.taskId,
      outcome: input.outcome,
      summary: input.summary,
      closedAt: yield* nowIso,
    });
    if (closed === null) {
      return yield* refuse("task_not_found", `Mail task "${task.taskId}" was not found.`);
    }
    return closed;
  });

  const purgeFinishedTasks = Effect.fn("MailService.purgeFinishedTasks")(function* (input: {
    readonly before: string;
    readonly limit: number;
  }) {
    // Claims settle in the same transaction as the purge, so no card keeps a claim
    // held by a member that no longer exists.
    return yield* repository.transaction(
      Effect.gen(function* () {
        for (const member of yield* repository.plannerMembersToPurge(input)) {
          if (member.participantThreadId !== null) {
            yield* planGate
              .bindPlanner({
                cardId: member.cardId,
                memberId: member.memberId,
                threadId: member.participantThreadId,
              })
              .pipe(Effect.mapError(planFailure));
          } else {
            yield* planGate
              .releasePlanner({ cardId: member.cardId, memberId: member.memberId })
              .pipe(Effect.mapError(planFailure));
          }
        }
        return yield* repository.purgeFinishedTasks(input);
      }),
    );
  });

  const settleMember = Effect.fn("MailService.settleMember")(function* (
    input: SettleMailMemberInput,
  ) {
    const member = yield* repository.getMember(input.memberId);
    if (member === null) return null;
    // One repository transaction: a crash anywhere leaves no partial settle state.
    const deliveryId = yield* newId;
    return yield* repository.applySettleNotice({
      memberId: member.memberId,
      roleId: member.roleId,
      settledAs: input.settledAs,
      at: input.at,
      letterId: yield* newId,
      clientRequestId: `mail:member-settle:${member.memberId}`,
      requestFingerprint: yield* fingerprintOf(["member-settle", member.taskId, member.memberId]),
      deliveryId,
      wakeId: `mail:wake:${deliveryId}`,
    });
  });

  const setMemberModel = Effect.fn("MailService.setMemberModel")(function* (
    input: SetMemberModelInput,
  ) {
    if (input.clientRequestId.trim() === "") {
      return yield* refuse("invalid_request", "A model override needs a client request id.");
    }
    const task = yield* requireMailTask(input.taskId);
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is closed.`);
    }
    if (task.createdByThreadId !== input.callerThreadId) {
      return yield* refuse("capability_denied", "Only the lead can override a member model.");
    }
    const member = yield* repository.getMember(input.memberId);
    if (member === null || member.taskId !== task.taskId) {
      return yield* refuse(
        "invalid_request",
        `Member "${input.memberId}" is not part of mail task "${task.taskId}".`,
      );
    }
    if (member.status !== "active") {
      return yield* refuse(
        "invalid_request",
        `Member "${input.memberId}" is closed and cannot be overridden.`,
      );
    }
    const override = yield* normalizeOverride({
      modelSelection: input.modelSelection,
      humanInstruction: input.humanInstruction,
    });
    if (override.modelOverrideJson === null || override.humanInstruction === null) {
      return yield* Effect.die(new Error("the normalized model override is missing"));
    }
    const updated = yield* repository.setMemberOverride({
      memberId: member.memberId,
      modelOverrideJson: override.modelOverrideJson,
      humanInstruction: override.humanInstruction,
      at: yield* nowIso,
    });
    if (updated === null) {
      return yield* refuse(
        "invalid_request",
        `Member "${input.memberId}" is not part of mail task "${task.taskId}".`,
      );
    }
    return updated;
  });

  return MailService.of({
    createTask,
    setMemberModel,
    sendLetter,
    setLetterKind,
    openRound,
    closeRound,
    readLetter,
    readTask,
    listTimeline,
    timeoutOverdueDeliveries,
    closeTask,
    settleMember,
    purgeFinishedTasks,
  });
});

export const layer = Layer.effect(MailService, make);
