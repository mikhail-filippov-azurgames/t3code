/**
 * Mail tasks for the lead and its participants: the task team, letters between
 * the lead and members, and the route chosen for each member. Launch, delivery
 * and wake belong to the next slice, so this service records state only.
 */
import { RoutingPolicyService, type RoutingSkippedCandidate } from "@t3tools/ft3-policies/routing";
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
import * as Schema from "effect/Schema";

import type {
  MailDelivery,
  MailIsolation,
  MailLetter,
  MailLetterKind,
  MailLevel,
  MailMember,
  MailOutcome,
  MailTask,
} from "./contracts.ts";
import { MailRepository, type MailRepositoryError } from "./repository.ts";

const DEFAULT_RESPONSE_BUDGET_SECONDS = 1800;
const MIN_RESPONSE_BUDGET_SECONDS = 60;
const MAX_RESPONSE_BUDGET_SECONDS = 86400;
const ROUTING_UNAVAILABLE = "The routing policy is not applied, so no participant can be routed.";

export const MailServiceErrorCode = Schema.Literals([
  "mail_disabled",
  "task_not_found",
  "task_closed",
  "members_active",
  "letter_not_found",
  "address_denied",
  "kind_denied",
  "invalid_role",
  "capability_denied",
  "idempotency_conflict",
  "invalid_request",
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

/**
 * Who may send which letter kind to whom. Participants never send `request`:
 * only the lead dispatches work. `approve` and `changes` are architect review answers.
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
          (sender.roleId === "architect" && CONSULTANT_REVIEW_KINDS.includes(kind)))
      );
  }
};

export interface MailMemberRequest {
  readonly role: string;
  readonly specialization?: string | null;
  readonly level?: MailLevel | null;
  readonly responseBudgetSeconds?: number | null;
  readonly documentsWrite?: boolean;
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

export interface SendMailLetterInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly to: string;
  readonly kind: MailLetterKind;
  readonly body: string;
  readonly replyToLetterId?: string | null;
  readonly clientRequestId: string;
}

export interface MailLetterNoCandidate extends MailNoCandidate {
  readonly memberId: string;
}

export interface SendMailLetterResult {
  readonly letter: MailLetter;
  readonly created: boolean;
  readonly deliveries: ReadonlyArray<MailDelivery>;
  readonly noCandidate: ReadonlyArray<MailLetterNoCandidate>;
}

export interface CloseMailTaskInput {
  readonly callerThreadId: string;
  readonly taskId: string;
  readonly outcome: MailOutcome;
  readonly summary: string;
}

/** The applied policy snapshot as JSON, and the board card that keeps it for a task that belongs to one. */
export class MailPolicyEvidence extends Context.Service<
  MailPolicyEvidence,
  {
    readonly snapshotJson: Effect.Effect<string>;
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
    readonly sendLetter: (
      input: SendMailLetterInput,
    ) => Effect.Effect<SendMailLetterResult, MailServiceError | MailRepositoryError>;
    readonly closeTask: (
      input: CloseMailTaskInput,
    ) => Effect.Effect<MailTask, MailServiceError | MailRepositoryError>;
  }
>()("@t3tools/ft3-mail/service/MailService") {}

const make = Effect.gen(function* () {
  const repository = yield* MailRepository;
  const routing = yield* RoutingPolicyService;
  const gate = yield* FeatureGate;
  const crypto = yield* Crypto.Crypto;
  const evidence = yield* MailPolicyEvidence;

  const requireMail = gate
    .require("mail")
    .pipe(
      Effect.mapError(
        (error) => new MailServiceError({ code: "mail_disabled", reason: error.message }),
      ),
    );
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

  const requireRoutingRole = Effect.fn("MailService.requireRoutingRole")(function* (role: string) {
    const roleId = routingRoleOf(role);
    if (roleId === null)
      return yield* refuse("invalid_role", `Role "${role}" is not a mail participant role.`);
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

  // Chooses and records the route of a new member; the usage row is keyed by the member id.
  const selectRoute = Effect.fn("MailService.selectRoute")(function* (
    memberId: string,
    role: RoutingRoleId,
    level: MailLevel,
  ) {
    const selection = yield* routing.select({ role, level, delegationId: memberId });
    if (selection === null) return yield* refuse("mail_disabled", ROUTING_UNAVAILABLE);
    return selection.selected === null ? { role, level, skipped: selection.skipped } : null;
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
      const specialization = member.specialization?.trim() ?? "";
      normalized.push({
        roleId,
        specialization: specialization === "" ? null : specialization,
        level: member.level ?? null,
        responseBudgetSeconds: budget,
        documentsWrite,
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
    yield* requireMail;
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
      ]),
    ]);
    const existing = yield* repository.getTaskByRequestKey({
      createdByThreadId: input.callerThreadId,
      clientRequestId: input.clientRequestId,
    });
    if (existing !== null) return yield* replayTask(existing, requestFingerprint);

    const taskId = yield* newId;
    const rows = yield* Effect.forEach(members, (member) =>
      newId.pipe(Effect.map((memberId) => ({ ...member, memberId }))),
    );
    const routes = yield* Effect.forEach(rows, (row) =>
      selectRoute(row.memberId, row.roleId, row.level ?? input.level),
    );
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
          modelOverrideJson: null,
          humanInstruction: null,
          participantThreadId: null,
          createdAt: now,
        })
        .pipe(Effect.map((member) => ({ member, noCandidate: routes[index] ?? null }))),
    );
    const cardId = input.cardId ?? null;
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
    yield* requireMail;
    const task = yield* requireTask(input.taskId);
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
    const targets = yield* resolveTargets(sender, recipient, task, members);
    for (const target of targets) {
      if (!mailKindAllowed(sender, target.target, input.kind)) {
        return yield* refuse(
          "kind_denied",
          `A ${sender.kind} cannot send a ${input.kind} letter to the ${target.target}.`,
        );
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
    const requestFingerprint = yield* fingerprintOf([to, input.kind, input.body, replyToLetterId]);
    const letterId = yield* newId;
    const now = yield* nowIso;
    const appended = yield* repository
      .appendLetter({
        letterId,
        taskId: task.taskId,
        senderThreadId: input.callerThreadId,
        recipient: to,
        kind: input.kind,
        body: input.body,
        replyToLetterId,
        sourceLetterId: null,
        planPhase: null,
        planStep: null,
        planSha256: null,
        planDocId: null,
        classifierKind: null,
        classifierConfidence: null,
        kindDisputed: false,
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
    // Recording is idempotent per (letter, recipient), so a replay heals a letter whose deliveries never landed.
    const deliveries = yield* Effect.forEach(targets, (target) =>
      newId.pipe(
        Effect.flatMap((deliveryId) =>
          repository.recordDelivery({
            deliveryId,
            taskId: task.taskId,
            letterId: appended.letter.letterId,
            memberId: target.memberId,
            recipient: target.recipient,
            participantThreadId: target.participantThreadId,
            createdAt: now,
          }),
        ),
      ),
    );
    const noCandidate: MailLetterNoCandidate[] = [];
    for (const target of targets) {
      if (target.member === null) continue;
      const gap = yield* noCandidateFor(target.member.roleId, target.member.level ?? task.level);
      if (gap !== null) noCandidate.push({ memberId: target.member.memberId, ...gap });
    }
    return { letter: appended.letter, created: appended.created, deliveries, noCandidate };
  });

  const closeTask = Effect.fn("MailService.closeTask")(function* (input: CloseMailTaskInput) {
    yield* requireMail;
    const task = yield* requireTask(input.taskId);
    if (task.createdByThreadId !== input.callerThreadId) {
      return yield* refuse("capability_denied", "Only the lead can close a mail task.");
    }
    if (task.status === "closed") {
      return yield* refuse("task_closed", `Mail task "${task.taskId}" is already closed.`);
    }
    const members = yield* repository.listMembers(task.taskId);
    if (members.some((member) => member.status === "active")) {
      return yield* refuse("members_active", "Close the task after its active members finish.");
    }
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

  return MailService.of({ createTask, sendLetter, closeTask });
});

export const layer = Layer.effect(MailService, make);
