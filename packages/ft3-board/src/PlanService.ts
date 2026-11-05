import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { docLinkOf } from "@t3tools/ft3-docs/contracts";
import { readDocsSettings } from "@t3tools/ft3-docs/root";
import * as DocsServer from "@t3tools/ft3-docs/server";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ProjectStoreV2 } from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import * as BoardMailFacts from "./boardMailFacts.ts";
import * as Contracts from "./contracts.ts";
import * as PlanningContracts from "./planningContracts.ts";
import { PLAN_TEMPLATE } from "./planTemplate.ts";
import { countPlanSteps, planStepIds, validatePlan } from "./planValidation.ts";

export const PlanErrorCode = Schema.Literals([
  "planning_disabled",
  "plan_card_not_found",
  "plan_not_found",
  "plan_transition_invalid",
  "plan_review_rounds_exhausted",
  "plan_changed",
  "plan_not_accepted",
  "plan_invalid",
  "plan_document_denied",
  "plan_document_failed",
  "plan_store_failed",
]);
export type PlanErrorCode = typeof PlanErrorCode.Type;

export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  code: PlanErrorCode,
  cardId: Schema.String,
  line: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "planning_disabled":
        return this.reason ?? "Planning is off. Open Settings → Policies.";
      case "plan_card_not_found":
        return `Card "${this.cardId}" was not found.`;
      case "plan_not_found":
        return `Card "${this.cardId}" has no plan.`;
      case "plan_transition_invalid":
        return `The plan of card "${this.cardId}" cannot change that way from its current state.`;
      case "plan_review_rounds_exhausted":
        return `Plan for card "${this.cardId}" has used its two review rounds.`;
      case "plan_changed":
        return `Plan for card "${this.cardId}" changed since it was reviewed. Read it again and accept the current version.`;
      case "plan_not_accepted":
        return `Plan for card "${this.cardId}" is not accepted: there is no accepted version to work from.`;
      case "plan_invalid":
        return `Plan for card "${this.cardId}" line ${this.line ?? 1}: ${this.reason ?? "invalid"}. Fix the plan and accept again.`;
      case "plan_document_denied":
        return `The plan document of card "${this.cardId}" cannot be written by this thread.`;
      case "plan_document_failed":
        return `The plan document of card "${this.cardId}" is unavailable.`;
      case "plan_store_failed":
        return `The plan store could not complete the change for card "${this.cardId}".`;
    }
  }
}

interface PlanRow {
  readonly card_id: string;
  readonly required: number;
  readonly required_by: PlanningContracts.PlanRequiredBy;
  readonly required_reason: string | null;
  readonly state: PlanningContracts.PlanState;
  readonly plan_doc_id: string;
  readonly planner_member_id: string | null;
  readonly planner_thread_id: string | null;
  readonly review_rounds: number;
  readonly accepted_sha256: string | null;
  readonly accepted_revision: number;
  readonly accepted_at: string | null;
  readonly updated_at: string;
}

const toRecord = (row: PlanRow): PlanningContracts.PlanRecord => ({
  cardId: row.card_id,
  required: row.required === 1,
  requiredBy: row.required_by,
  requiredReason: row.required_reason as PlanningContracts.PlanReason | null,
  state: row.state,
  planDocId: row.plan_doc_id,
  plannerMemberId: row.planner_member_id,
  plannerThreadId: row.planner_thread_id,
  reviewRounds: row.review_rounds,
  acceptedSha256: row.accepted_sha256,
  acceptedRevision: row.accepted_revision,
  acceptedAt: row.accepted_at,
  updatedAt: row.updated_at,
});

/** Store path segment of a project: its title in ASCII, or its id when the title has none. */
const slugOf = (title: string, fallback: string): string => {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug === "" ? fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-") : slug;
};

const renderPlan = (template: string, cardId: string, title: string): string =>
  template.replace("<cardId>", () => cardId).replace("<card title>", () => title);

/**
 * Reports a plan failure as the matching board failure, so RPC and MCP
 * handlers share one mapping.
 */
export const planFailureCode = (failure: PlanError): Contracts.BoardMcpFailure["code"] => {
  switch (failure.code) {
    case "planning_disabled":
      return "feature_disabled";
    case "plan_document_denied":
      return "capability_denied";
    case "plan_not_found":
      return "plan_not_found";
    case "plan_card_not_found":
      return "task_not_found";
    case "plan_transition_invalid":
      return "plan_transition_invalid";
    case "plan_review_rounds_exhausted":
      return "plan_review_rounds_exhausted";
    case "plan_changed":
      return "plan_changed";
    case "plan_not_accepted":
      return "plan_not_accepted";
    case "plan_document_failed":
      return "orchestration_error";
    case "plan_store_failed":
    case "plan_invalid":
    default:
      return "invalid_request";
  }
};

/**
 * Who may run the card's planner: `Launch` when this member claimed the card and
 * may start the thread, `Bound` when the card already has one, `Pending` while
 * another member's launch has not recorded its thread yet.
 */
export type PlannerClaim =
  | { readonly _tag: "Launch" }
  | { readonly _tag: "Bound"; readonly threadId: string }
  | { readonly _tag: "Pending" };

export class PlanService extends Context.Service<
  PlanService,
  {
    readonly get: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord | null, PlanError>;
    /** Flags the card; creates its plan document on the first flag. Refused while planning is off. */
    readonly require: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly requiredBy: PlanningContracts.PlanRequiredBy;
      readonly reason?: PlanningContracts.PlanReason;
    }) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly beginDraft: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly recordDraft: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly openReviewRound: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly closeReviewRound: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly submitForDiscussion: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    /** Accepts the version the human saw: `sha256` must be the live document's digest. */
    readonly accept: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly sha256: string;
    }) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly withdraw: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    readonly bindPlannerThread: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    /** Claims the card's planner for a member; the first claim wins, a repeat by the same member is `Launch` again. */
    readonly claimPlanner: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly memberId: string;
    }) => Effect.Effect<PlannerClaim, PlanError>;
    /** Records the thread of the member that claimed the card; only that member binds, and a bound card stays bound. */
    readonly bindPlanner: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly memberId: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, PlanError>;
    /** Drops the claim of its owner while no thread is recorded; a bound card keeps its planner. */
    readonly releasePlanner: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly memberId: string;
    }) => Effect.Effect<void, PlanError>;
    /** The plan document a planner thread may write; null for any other thread. */
    readonly planStableIdOfPlannerThread: (
      threadId: string,
    ) => Effect.Effect<string | null, PlanError>;
    /**
     * Records that an implement letter was sent for the card; survives mail
     * retention purges that delete the letters. Idempotent.
     */
    readonly markImplementStarted: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<PlanningContracts.PlanRecord, PlanError>;
    /** Version rows of the card's plan, oldest first. */
    readonly listVersions: (cardId: Contracts.BoardCardId) => Effect.Effect<
      ReadonlyArray<{
        readonly phase: string;
        readonly sha256: string;
        readonly createdAt: string;
      }>,
      PlanError
    >;
    /**
     * One plan read for viewers and agents: the record, the document address,
     * the digest of the requested version, its step ids, and the content for
     * the accepted snapshot (null for the live document).
     */
    readonly readDetail: (input: {
      readonly cardId: Contracts.BoardCardId;
      readonly version: "current" | "accepted";
    }) => Effect.Effect<
      {
        readonly record: PlanningContracts.PlanRecord;
        readonly doc: {
          readonly stableId: string;
          readonly relPath: string;
          readonly name: string;
        };
        readonly sha256: string;
        readonly stepIds: ReadonlyArray<string>;
        readonly content: string | null;
      },
      PlanError
    >;
    /**
     * One small summary per planned card of the given cards, for the board
     * card list response. Step counts are cached by document digest, so an
     * unchanged plan is neither re-read nor re-parsed.
     */
    readonly listSummaries: (input: {
      readonly cardIds: ReadonlyArray<Contracts.BoardCardId>;
    }) => Effect.Effect<ReadonlyArray<Contracts.BoardCardPlanSummary>, PlanError>;
  }
>()("@t3tools/ft3-board/PlanService") {}

/** A cached step count with the signals that produced it. */
export interface StepCountEntry {
  readonly fingerprint: string;
  readonly sha256: string;
  readonly stepCount: number;
}

/** Bound on cached step counts; the oldest entry is evicted past the cap. */
export const MAX_CACHED_STEP_COUNTS = 500;

const storeFailure =
  (cardId: string) =>
  (cause: unknown): PlanError =>
    new PlanError({ code: "plan_store_failed", cardId, cause });

interface PendingAcceptEvent {
  readonly cardId: string;
  readonly revision: number;
  readonly planDocId: string;
  readonly sha256: string;
}

/** The lead event for one accepted revision. Its id is the dedupe key, so a redelivery is a no-op. */
const acceptedLeadEvent = (input: {
  readonly cardId: string;
  readonly revision: number;
  readonly planDocId: string;
  readonly sha256: string | null;
  readonly orchestratorThreadId: string;
  readonly title: string;
}) => {
  const id = `ft3:plan:accepted:${input.cardId}:${input.revision}`;
  const text =
    `Plan accepted for card "${input.title}": oc://doc/${input.planDocId}, ` +
    `revision ${input.revision} (sha256 ${(input.sha256 ?? "").slice(0, 12)}). ` +
    `Dispatch implementation strictly by steps of plan_read(version: accepted).`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId: ThreadId.make(input.orchestratorThreadId),
    messageId: MessageId.make(id),
    text,
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "start_immediately" },
  } as const;
};

/** Undelivered accepted events of one card, or of every card when `cardId` is null. */
const pendingAccepts = (sql: SqlClient.SqlClient, cardId: string | null) =>
  sql<{
    readonly card_id: string;
    readonly revision: number;
    readonly plan_doc_id: string;
    readonly sha256: string;
  }>`SELECT card_id, revision, plan_doc_id, sha256 FROM ft3_board_plan_accept_outbox
    WHERE delivered_at IS NULL AND (${cardId} IS NULL OR card_id = ${cardId})
    ORDER BY card_id, revision`.pipe(
    Effect.map((rows) =>
      rows.map((row): PendingAcceptEvent => ({
        cardId: row.card_id,
        revision: row.revision,
        planDocId: row.plan_doc_id,
        sha256: row.sha256,
      })),
    ),
    Effect.mapError(storeFailure(cardId ?? "")),
  );

/**
 * Sends one pending accepted event and marks it delivered. A failed dispatch
 * leaves the row pending, so the next accept retry or restart redelivers it.
 */
const sendPendingAccept = Effect.fn("PlanService.sendPendingAccept")(function* (
  sql: SqlClient.SqlClient,
  threads: ThreadManagement.ThreadManagementServiceShape,
  row: PendingAcceptEvent,
) {
  const card = yield* sql<{
    readonly orchestrator_thread_id: string;
    readonly title: string;
  }>`SELECT orchestrator_thread_id, title FROM ft3_board_cards WHERE card_id = ${row.cardId}`.pipe(
    Effect.mapError(storeFailure(row.cardId)),
  );
  const current = card[0];
  if (current === undefined) {
    return yield* new PlanError({ code: "plan_card_not_found", cardId: row.cardId });
  }
  yield* threads
    .dispatch(
      acceptedLeadEvent({
        cardId: row.cardId,
        revision: row.revision,
        planDocId: row.planDocId,
        sha256: row.sha256,
        orchestratorThreadId: current.orchestrator_thread_id,
        title: current.title,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new PlanError({ code: "plan_store_failed", cardId: row.cardId, cause }),
      ),
    );
  const at = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* sql`UPDATE ft3_board_plan_accept_outbox SET delivered_at = ${yield* at} WHERE card_id = ${row.cardId} AND revision = ${row.revision} AND delivered_at IS NULL`.pipe(
    Effect.mapError(storeFailure(row.cardId)),
  );
});

/** Delivers the pending accepted events of one card, or of every card when `cardId` is null. */
const deliverPendingAccepts = Effect.fn("PlanService.deliverPendingAccepts")(function* (
  sql: SqlClient.SqlClient,
  threads: ThreadManagement.ThreadManagementServiceShape,
  cardId: string | null,
) {
  for (const row of yield* pendingAccepts(sql, cardId)) {
    yield* sendPendingAccept(sql, threads, row);
  }
});

/**
 * Stores a step count in place, refreshing recency of a re-stored key and
 * evicting the oldest entries past the cap. The cap alone bounds the cache;
 * no per-list scan of the plans table is needed.
 */
export const storeStepCount = (
  cache: Map<string, StepCountEntry>,
  planDocId: string,
  entry: StepCountEntry,
  cap: number = MAX_CACHED_STEP_COUNTS,
): void => {
  if (cache.has(planDocId)) cache.delete(planDocId);
  else {
    while (cache.size >= cap) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  cache.set(planDocId, entry);
};

const make = Effect.fn("PlanService.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const docs = yield* DocsServer.DocsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const gate = yield* FeatureGate.FeatureGate;
  const mailFacts = yield* BoardMailFacts.BoardMailFacts;
  const serverSettings = yield* ServerSettingsService;
  // Snapshot of the setting at layer build, like the docs root: an id-addressed
  // plan survives a folder change, only new plan documents land in the new folder.
  const plansFolder = readDocsSettings(
    (yield* serverSettings.getSettings.pipe(Effect.orDie)).ft3,
  ).plansFolder;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const documentFailure = (cardId: string) => (cause: DocsServer.DocsServiceError) =>
    new PlanError({
      code: cause.code === "capability_denied" ? "plan_document_denied" : "plan_document_failed",
      cardId,
      cause,
    });

  const selectRecord = (cardId: string) =>
    sql<PlanRow>`SELECT * FROM ft3_board_card_plans WHERE card_id = ${cardId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
      Effect.mapError(storeFailure(cardId)),
    );

  const loadRecord = Effect.fn("PlanService.loadRecord")(function* (cardId: Contracts.BoardCardId) {
    const record = yield* selectRecord(cardId);
    if (record === null) return yield* new PlanError({ code: "plan_not_found", cardId });
    return record;
  });

  const requireState = (
    record: PlanningContracts.PlanRecord,
    from: ReadonlyArray<PlanningContracts.PlanState>,
  ) =>
    from.includes(record.state)
      ? Effect.void
      : Effect.fail(new PlanError({ code: "plan_transition_invalid", cardId: record.cardId }));

  const readPlanDocument = (record: PlanningContracts.PlanRecord) =>
    docs
      .read({ ref: docLinkOf(record.planDocId) })
      .pipe(Effect.mapError(documentFailure(record.cardId)));

  const insertRecord = (record: PlanningContracts.PlanRecord) =>
    sql`INSERT INTO ft3_board_card_plans (card_id, required, required_by, required_reason, state, plan_doc_id, planner_member_id, planner_thread_id, review_rounds, accepted_sha256, accepted_revision, accepted_at, updated_at) VALUES (${record.cardId}, ${record.required ? 1 : 0}, ${record.requiredBy}, ${record.requiredReason}, ${record.state}, ${record.planDocId}, ${record.plannerMemberId}, ${record.plannerThreadId}, ${record.reviewRounds}, ${record.acceptedSha256}, ${record.acceptedRevision}, ${record.acceptedAt}, ${record.updatedAt})`;

  const saveRecord = (record: PlanningContracts.PlanRecord) =>
    sql`UPDATE ft3_board_card_plans SET required = ${record.required ? 1 : 0}, required_by = ${record.requiredBy}, required_reason = ${record.requiredReason}, state = ${record.state}, planner_member_id = ${record.plannerMemberId}, planner_thread_id = ${record.plannerThreadId}, review_rounds = ${record.reviewRounds}, accepted_sha256 = ${record.acceptedSha256}, accepted_revision = ${record.acceptedRevision}, accepted_at = ${record.acceptedAt}, updated_at = ${record.updatedAt} WHERE card_id = ${record.cardId}`;

  /** Writes the record and, when given, its version in one transaction; document I/O happens before. */
  const commit = (
    record: PlanningContracts.PlanRecord,
    version: {
      readonly phase: PlanningContracts.PlanVersionPhase;
      readonly sha256: string;
      readonly content: string;
    } | null,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (version !== null) {
            yield* sql`INSERT OR IGNORE INTO ft3_board_plan_versions (card_id, sha256, phase, content, created_at) VALUES (${record.cardId}, ${version.sha256}, ${version.phase}, ${version.content}, ${record.updatedAt})`;
          }
          yield* saveRecord(record);
        }),
      )
      .pipe(Effect.mapError(storeFailure(record.cardId)));

  const insertAcceptOutbox = (input: {
    readonly cardId: string;
    readonly revision: number;
    readonly planDocId: string;
    readonly sha256: string;
    readonly at: string;
  }) =>
    sql`INSERT INTO ft3_board_plan_accept_outbox (card_id, revision, plan_doc_id, sha256, created_at) VALUES (${input.cardId}, ${input.revision}, ${input.planDocId}, ${input.sha256}, ${input.at})`.pipe(
      Effect.mapError(storeFailure(input.cardId)),
    );

  const createPlanDocument = Effect.fn("PlanService.createPlanDocument")(function* (
    cardId: Contracts.BoardCardId,
    orchestratorThreadId: string,
    title: string,
  ) {
    const orchestratorId = ThreadId.make(orchestratorThreadId);
    const shell = yield* threads
      .getThreadShell(orchestratorId)
      .pipe(
        Effect.mapError((cause) => new PlanError({ code: "plan_document_failed", cardId, cause })),
      );
    if (shell === null) return yield* new PlanError({ code: "plan_document_failed", cardId });
    const project = yield* projects
      .getShell(shell.projectId)
      .pipe(
        Effect.mapError((cause) => new PlanError({ code: "plan_document_failed", cardId, cause })),
      );
    const slug = slugOf(Option.isSome(project) ? project.value.title : "", String(shell.projectId));
    const written = yield* docs
      .write({
        caller: {
          threadId: orchestratorId,
          parentThreadId: shell.lineage.parentThreadId,
        },
        relPath: `${plansFolder}/${slug}/${cardId}.md`,
        content: renderPlan(PLAN_TEMPLATE, cardId, title),
        clientRequestId: `plan:${cardId}`,
      })
      .pipe(Effect.mapError(documentFailure(cardId)));
    return written.stableId;
  });

  const requirePlan = Effect.fn("PlanService.require")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly requiredBy: PlanningContracts.PlanRequiredBy;
    readonly reason?: PlanningContracts.PlanReason;
  }) {
    yield* gate.require("planning").pipe(
      Effect.mapError(
        (error) =>
          new PlanError({
            code: "planning_disabled",
            cardId: input.cardId,
            reason: error.message,
            cause: error,
          }),
      ),
    );
    const existing = yield* selectRecord(input.cardId);
    if (existing !== null && existing.required) return existing;
    const at = yield* nowIso;
    if (existing !== null) {
      const next: PlanningContracts.PlanRecord = {
        ...existing,
        required: true,
        requiredBy: input.requiredBy,
        requiredReason: input.reason ?? null,
        state: "required",
        updatedAt: at,
      };
      yield* commit(next, null);
      return next;
    }
    const card = yield* sql<{
      readonly orchestrator_thread_id: string;
      readonly title: string;
    }>`SELECT orchestrator_thread_id, title FROM ft3_board_cards WHERE card_id = ${input.cardId}`.pipe(
      Effect.mapError(storeFailure(input.cardId)),
    );
    const row = card[0];
    if (row === undefined)
      return yield* new PlanError({ code: "plan_card_not_found", cardId: input.cardId });
    const planDocId = yield* createPlanDocument(
      input.cardId,
      row.orchestrator_thread_id,
      row.title,
    );
    const record: PlanningContracts.PlanRecord = {
      cardId: input.cardId,
      required: true,
      requiredBy: input.requiredBy,
      requiredReason: input.reason ?? null,
      state: "required",
      planDocId,
      plannerMemberId: null,
      plannerThreadId: null,
      reviewRounds: 0,
      acceptedSha256: null,
      acceptedRevision: 0,
      acceptedAt: null,
      updatedAt: at,
    };
    yield* insertRecord(record).pipe(Effect.mapError(storeFailure(input.cardId)));
    return record;
  });

  const beginDraft = Effect.fn("PlanService.beginDraft")(function* (cardId: Contracts.BoardCardId) {
    const record = yield* loadRecord(cardId);
    yield* requireState(record, ["required", "drafting", "reviewing", "discussion"]);
    const next = { ...record, state: "drafting" as const, updatedAt: yield* nowIso };
    yield* commit(next, null);
    return next;
  });

  const recordDraft = Effect.fn("PlanService.recordDraft")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    const record = yield* loadRecord(cardId);
    yield* requireState(record, ["drafting"]);
    const doc = yield* readPlanDocument(record);
    const next = { ...record, updatedAt: yield* nowIso };
    yield* commit(next, { phase: "draft", sha256: doc.sha256, content: doc.content });
    return next;
  });

  const openReviewRound = Effect.fn("PlanService.openReviewRound")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    const record = yield* loadRecord(cardId);
    yield* requireState(record, ["drafting"]);
    if (record.reviewRounds >= 2) {
      return yield* new PlanError({ code: "plan_review_rounds_exhausted", cardId });
    }
    const next = {
      ...record,
      state: "reviewing" as const,
      reviewRounds: record.reviewRounds + 1,
      updatedAt: yield* nowIso,
    };
    yield* commit(next, null);
    return next;
  });

  const closeReviewRound = Effect.fn("PlanService.closeReviewRound")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    const record = yield* loadRecord(cardId);
    yield* requireState(record, ["reviewing"]);
    const doc = yield* readPlanDocument(record);
    const next = { ...record, state: "drafting" as const, updatedAt: yield* nowIso };
    const phase = record.reviewRounds >= 2 ? "review_2" : "review_1";
    yield* commit(next, { phase, sha256: doc.sha256, content: doc.content });
    return next;
  });

  /**
   * Marks the card so the human sees what the plan flow needs: discussion
   * waits for the human, an accepted plan clears the card back to ready.
   */
  const setCardReadiness = Effect.fn("PlanService.setCardReadiness")(function* (
    cardId: Contracts.BoardCardId,
    readiness: "needs_human" | "ready",
    note: string | null,
  ) {
    const at = yield* nowIso;
    yield* sql`UPDATE ft3_board_cards SET readiness = ${readiness}, readiness_note = ${note},
      updated_at = ${at} WHERE card_id = ${cardId}`.pipe(Effect.mapError(storeFailure(cardId)));
  });

  const latestVersionSha = Effect.fn("PlanService.latestVersionSha")(function* (
    cardId: Contracts.BoardCardId,
    phase: string,
  ) {
    const rows = yield* sql<{ readonly sha256: string }>`
      SELECT sha256 FROM ft3_board_plan_versions
      WHERE card_id = ${cardId} AND phase = ${phase}
      ORDER BY created_at DESC LIMIT 1
    `.pipe(Effect.mapError(storeFailure(cardId)));
    return rows[0]?.sha256 ?? null;
  });

  const submitForDiscussion = Effect.fn("PlanService.submitForDiscussion")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    const record = yield* loadRecord(cardId);
    let next = record;
    if (record.state === "discussion") {
      // Retry-safe: an unchanged plan resubmits as a no-op success instead of
      // a version-spamming failure. A changed draft records a new version.
      const doc = yield* readPlanDocument(record);
      const latest = yield* latestVersionSha(cardId, "discussion");
      if (latest === null || latest !== doc.sha256) {
        next = { ...record, updatedAt: yield* nowIso };
        yield* commit(next, { phase: "discussion", sha256: doc.sha256, content: doc.content });
      }
    } else {
      yield* requireState(record, ["drafting", "reviewing", "accepted"]);
      const doc = yield* readPlanDocument(record);
      next = { ...record, state: "discussion" as const, updatedAt: yield* nowIso };
      yield* commit(next, { phase: "discussion", sha256: doc.sha256, content: doc.content });
    }
    yield* setCardReadiness(cardId, "needs_human", "Waiting for the human to accept the plan.");
    return next;
  });

  const accept = Effect.fn("PlanService.accept")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly sha256: string;
  }) {
    const record = yield* loadRecord(input.cardId);
    if (record.state === "accepted" && record.acceptedSha256 === input.sha256) {
      const live = yield* readPlanDocument(record);
      if (live.sha256 !== input.sha256) {
        return yield* new PlanError({ code: "plan_changed", cardId: input.cardId });
      }
      yield* deliverPendingAccepts(sql, threads, record.cardId);
      return record;
    }
    if (record.state === "accepted") {
      return yield* new PlanError({ code: "plan_changed", cardId: input.cardId });
    }
    yield* requireState(record, ["discussion"]);
    const doc = yield* readPlanDocument(record);
    if (doc.sha256 !== input.sha256) {
      return yield* new PlanError({ code: "plan_changed", cardId: input.cardId });
    }
    const issue = validatePlan(doc.content, input.cardId)[0];
    if (issue !== undefined) {
      return yield* new PlanError({
        code: "plan_invalid",
        cardId: input.cardId,
        line: issue.line,
        reason: issue.reason,
      });
    }
    const at = yield* nowIso;
    const next: PlanningContracts.PlanRecord = {
      ...record,
      state: "accepted",
      acceptedSha256: doc.sha256,
      acceptedRevision: record.acceptedRevision + 1,
      acceptedAt: at,
      updatedAt: at,
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* commit(next, { phase: "accepted", sha256: doc.sha256, content: doc.content });
          yield* setCardReadiness(input.cardId, "ready", null);
          yield* insertAcceptOutbox({
            cardId: next.cardId,
            revision: next.acceptedRevision,
            planDocId: next.planDocId,
            sha256: doc.sha256,
            at,
          });
        }),
      )
      .pipe(Effect.mapError(storeFailure(input.cardId)));
    yield* deliverPendingAccepts(sql, threads, input.cardId);
    return next;
  });

  const withdraw = Effect.fn("PlanService.withdraw")(function* (cardId: Contracts.BoardCardId) {
    const record = yield* loadRecord(cardId);
    const next = {
      ...record,
      required: false,
      state: "withdrawn" as const,
      updatedAt: yield* nowIso,
    };
    yield* commit(next, null);
    return next;
  });

  const bindPlannerThread = Effect.fn("PlanService.bindPlannerThread")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly threadId: ThreadId;
  }) {
    const record = yield* loadRecord(input.cardId);
    const next = { ...record, plannerThreadId: input.threadId, updatedAt: yield* nowIso };
    yield* commit(next, null);
    return next;
  });

  /**
   * The claim is one transaction: the first member to find the planner column
   * empty takes it, so a concurrent task cannot also see the card as free.
   */
  const claimPlanner = Effect.fn("PlanService.claimPlanner")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly memberId: string;
  }) {
    const rows = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE ft3_board_card_plans SET planner_member_id = ${input.memberId}
            WHERE card_id = ${input.cardId} AND planner_member_id IS NULL`;
          return yield* sql<{
            readonly planner_member_id: string | null;
            readonly planner_thread_id: string | null;
          }>`SELECT planner_member_id, planner_thread_id FROM ft3_board_card_plans
            WHERE card_id = ${input.cardId}`;
        }),
      )
      .pipe(Effect.mapError(storeFailure(input.cardId)));
    const row = rows[0];
    if (row === undefined) {
      return yield* new PlanError({ code: "plan_not_found", cardId: input.cardId });
    }
    if (row.planner_thread_id !== null) {
      return { _tag: "Bound", threadId: row.planner_thread_id } as const;
    }
    return row.planner_member_id === input.memberId
      ? ({ _tag: "Launch" } as const)
      : ({ _tag: "Pending" } as const);
  });

  const bindPlanner = Effect.fn("PlanService.bindPlanner")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly memberId: string;
    readonly threadId: ThreadId;
  }) {
    const at = yield* nowIso;
    yield* sql`UPDATE ft3_board_card_plans SET planner_thread_id = ${input.threadId}, updated_at = ${at}
      WHERE card_id = ${input.cardId} AND planner_member_id = ${input.memberId}
        AND planner_thread_id IS NULL`.pipe(Effect.mapError(storeFailure(input.cardId)));
  });

  const releasePlanner = Effect.fn("PlanService.releasePlanner")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly memberId: string;
  }) {
    yield* sql`UPDATE ft3_board_card_plans SET planner_member_id = NULL
      WHERE card_id = ${input.cardId} AND planner_member_id = ${input.memberId}
        AND planner_thread_id IS NULL`.pipe(Effect.mapError(storeFailure(input.cardId)));
  });

  const planStableIdOfPlannerThread = Effect.fn("PlanService.planStableIdOfPlannerThread")(
    function* (threadId: string) {
      const rows = yield* sql<{
        readonly plan_doc_id: string;
      }>`SELECT plan_doc_id FROM ft3_board_card_plans WHERE planner_thread_id = ${threadId}`.pipe(
        Effect.mapError(storeFailure("")),
      );
      return rows[0]?.plan_doc_id ?? null;
    },
  );

  /**
   * Records that an implement letter was sent for the card. The flag survives
   * mail retention purges; the list backfill keeps older letters covered.
   * Idempotent: a set flag stays untouched.
   */
  const markImplementStarted = Effect.fn("PlanService.markImplementStarted")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    yield* loadRecord(cardId);
    const at = yield* nowIso;
    yield* sql`UPDATE ft3_board_card_plans SET implement_started_at = ${at}
      WHERE card_id = ${cardId} AND implement_started_at IS NULL`.pipe(
      Effect.mapError(storeFailure(cardId)),
    );
    return yield* loadRecord(cardId);
  });

  const listVersions = Effect.fn("PlanService.listVersions")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    yield* loadRecord(cardId);
    const rows = yield* sql<{
      readonly phase: string;
      readonly sha256: string;
      readonly created_at: string;
    }>`SELECT phase, sha256, created_at FROM ft3_board_plan_versions
      WHERE card_id = ${cardId} ORDER BY created_at ASC`.pipe(
      Effect.mapError(storeFailure(cardId)),
    );
    return rows.map((row) => ({
      phase: row.phase,
      sha256: row.sha256,
      createdAt: row.created_at,
    }));
  });

  const readDetail = Effect.fn("PlanService.readDetail")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly version: "current" | "accepted";
  }) {
    const record = yield* loadRecord(input.cardId);
    const meta = yield* docs
      .docRef(docLinkOf(record.planDocId))
      .pipe(Effect.mapError(documentFailure(record.cardId)));
    const doc = { stableId: meta.stableId, relPath: meta.relPath, name: meta.name };
    if (input.version === "current") {
      const body = yield* readPlanDocument(record);
      return {
        record,
        doc,
        sha256: body.sha256,
        stepIds: planStepIds(body.content),
        content: null,
      };
    }
    if (record.acceptedSha256 === null) {
      return yield* new PlanError({ code: "plan_not_accepted", cardId: input.cardId });
    }
    const rows = yield* sql<{ readonly content: string }>`
      SELECT content FROM ft3_board_plan_versions
      WHERE card_id = ${input.cardId} AND phase = 'accepted' AND sha256 = ${record.acceptedSha256}
      ORDER BY created_at DESC LIMIT 1
    `.pipe(Effect.mapError(storeFailure(input.cardId)));
    const snapshot = rows[0];
    if (snapshot === undefined) {
      return yield* new PlanError({ code: "plan_not_accepted", cardId: input.cardId });
    }
    return {
      record,
      doc,
      sha256: record.acceptedSha256,
      stepIds: planStepIds(snapshot.content),
      content: snapshot.content,
    };
  });

  /** Step counts by plan document, keyed by the digest the count was parsed from. */
  const stepCounts = yield* Ref.make(new Map<string, StepCountEntry>());

  /**
   * Cards among the candidates with an implement letter on their mail task,
   * answered through the BoardMailFacts port so this file names no mail table.
   */
  const newlyImplementedCardIds = (cardIds: ReadonlyArray<string>) =>
    mailFacts.hasImplementLetter(cardIds);

  /**
   * Cheap change fingerprint of a plan document from its filesystem stat,
   * without opening the file: sub-millisecond mtime plus byte size. Every
   * write path refreshes the stat, so service saves and external edits alike
   * invalidate the cached step count.
   */
  const fingerprintOf = Effect.fn("PlanService.planFingerprint")(function* (planDocId: string) {
    const stat = yield* docs.docStat(docLinkOf(planDocId)).pipe(Effect.orElseSucceed(() => null));
    return stat === null ? "missing" : `${stat.mtimeMs}:${stat.size}`;
  });

  interface SummaryRow {
    readonly card_id: string;
    readonly state: PlanningContracts.PlanState;
    readonly plan_doc_id: string;
    readonly planner_thread_id: string | null;
    readonly implement_started_at: string | null;
    readonly title: string;
  }

  const summaryOf = Effect.fn("PlanService.planSummary")(function* (
    row: SummaryRow,
    implementStarted: boolean | null,
  ) {
    const summarize = (stepCount: number): Contracts.BoardCardPlanSummary => ({
      cardId: Contracts.BoardCardId.make(row.card_id),
      planDocId: row.plan_doc_id,
      title: row.title,
      status: row.state,
      stepCount,
      plannerThreadId: row.planner_thread_id === null ? null : ThreadId.make(row.planner_thread_id),
      implementStarted,
    });
    // A fingerprint is best-effort metadata; when it fails, re-read below.
    const stamp = yield* fingerprintOf(row.plan_doc_id).pipe(
      Effect.orElseSucceed(() => "unavailable"),
    );
    const cached = (yield* Ref.get(stepCounts)).get(row.plan_doc_id);
    if (cached !== undefined && cached.fingerprint === stamp) return summarize(cached.stepCount);
    // A missing plan document still reports its state; the step count stays
    // zero so one broken plan cannot fail the whole card list.
    const document = yield* docs.read({ ref: docLinkOf(row.plan_doc_id) }).pipe(
      Effect.map((read) => ({ content: read.content, sha256: read.sha256 })),
      Effect.orElseSucceed(() => null),
    );
    const cache = yield* Ref.get(stepCounts);
    if (document === null) {
      cache.delete(row.plan_doc_id);
      return summarize(0);
    }
    const stepCount =
      cached !== undefined && cached.sha256 === document.sha256
        ? cached.stepCount
        : countPlanSteps(document.content);
    storeStepCount(cache, row.plan_doc_id, {
      fingerprint: stamp,
      sha256: document.sha256,
      stepCount,
    });
    return summarize(stepCount);
  });

  const listSummaries = Effect.fn("PlanService.listSummaries")(function* (input: {
    readonly cardIds: ReadonlyArray<Contracts.BoardCardId>;
  }) {
    if (input.cardIds.length === 0) return [];
    const rows = yield* sql<SummaryRow>`
      SELECT p.card_id, p.state, p.plan_doc_id, p.planner_thread_id,
             p.implement_started_at, c.title
      FROM ft3_board_card_plans AS p
      JOIN ft3_board_cards AS c ON c.card_id = p.card_id
      WHERE p.card_id IN ${sql.in(input.cardIds)}
      ORDER BY p.card_id
    `.pipe(Effect.mapError(storeFailure("")));
    if (rows.length === 0) return [];
    // The persisted flag survives mail retention purges, which delete the
    // implement letters the flag used to derive from. The join below runs only
    // for plans whose flag is not yet set and backfills it when one is found;
    // writes stay in the board package, the mail side never touches plan rows.
    const unset = rows.filter((row) => row.implement_started_at === null);
    // A failed lookup leaves the unset flags unknown: nothing is backfilled and the cards still list.
    const lookup = yield* newlyImplementedCardIds(unset.map((row) => row.card_id)).pipe(
      Effect.map((found) => ({ known: true, found })),
      Effect.catchTags({
        BoardMailFactsError: (error) =>
          Effect.logWarning("plan implement lookup failed", { error: String(error.cause) }).pipe(
            Effect.as({ known: false, found: new Set<string>() }),
          ),
      }),
    );
    if (lookup.known && lookup.found.size > 0) {
      const at = yield* nowIso;
      yield* sql`UPDATE ft3_board_card_plans SET implement_started_at = ${at}
        WHERE card_id IN ${sql.in([...lookup.found])} AND implement_started_at IS NULL`.pipe(
        Effect.mapError(storeFailure("")),
        Effect.asVoid,
      );
    }
    const implementStartedOf = (row: SummaryRow): boolean | null => {
      if (row.implement_started_at !== null || lookup.found.has(row.card_id)) return true;
      return lookup.known ? false : null;
    };
    return yield* Effect.forEach(rows, (row) => summaryOf(row, implementStartedOf(row)), {
      concurrency: 8,
    });
  });

  return PlanService.of({
    get: Effect.fn("PlanService.get")((cardId) => selectRecord(cardId)),
    require: requirePlan,
    beginDraft,
    recordDraft,
    openReviewRound,
    closeReviewRound,
    submitForDiscussion,
    accept,
    withdraw,
    bindPlannerThread,
    claimPlanner,
    bindPlanner,
    releasePlanner,
    planStableIdOfPlannerThread,
    listSummaries,
    markImplementStarted,
    listVersions,
    readDetail,
  });
});

export const planServiceLayer = Layer.effect(PlanService, make());

/**
 * Startup redelivery of the accepted-event outbox. Runs in the automation
 * worker with only the database and the dispatcher. A row that still fails
 * stays pending and is logged, so one bad row cannot block server startup.
 */
export const planAcceptOutboxDrainLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const rows = yield* pendingAccepts(sql, null).pipe(
      Effect.catch((error) =>
        Effect.logWarning("plan accept outbox unreadable", { error: error.message }).pipe(
          Effect.as([]),
        ),
      ),
    );
    for (const row of rows) {
      yield* sendPendingAccept(sql, threads, row).pipe(
        Effect.catch((error) =>
          Effect.logWarning("plan accept event still pending", {
            cardId: row.cardId,
            revision: row.revision,
            error: error.message,
          }),
        ),
      );
    }
  }),
);

/**
 * The docs write rule's facts for planners: a thread that is some card's planner
 * may write that card's plan document and nothing else. Failures read as no plan.
 */
export const planningDocumentsWriteFacts = Layer.effect(
  DocsServer.DocumentsWriteFactsPort,
  Effect.gen(function* () {
    const plans = yield* PlanService;
    return DocsServer.DocumentsWriteFactsPort.of({
      factsOf: Effect.fn("PlanService.documentsWriteFacts")(function* (caller) {
        let planStableId: string | null = null;
        if (caller.threadId !== null) {
          planStableId = yield* plans
            .planStableIdOfPlannerThread(caller.threadId)
            .pipe(Effect.orElseSucceed(() => null));
        }
        return { role: null, planStableId, granted: false };
      }),
    });
  }),
);

/**
 * The same plan identity without the plan service: one indexed lookup on the
 * plan record table, so compositions that cannot build `PlanService` (its
 * docs service would close the protection/facts cycle) can still wire the
 * planner's right. A missing table or row reads as no plan, never as a right.
 */
export const planningDocumentsWriteFactsSql = Layer.effect(
  DocsServer.DocumentsWriteFactsPort,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return DocsServer.DocumentsWriteFactsPort.of({
      factsOf: Effect.fn("PlanService.documentsWriteFactsFromPlanTable")(function* (caller) {
        if (caller.threadId === null) {
          return { role: null, planStableId: null, granted: false };
        }
        const planStableId = yield* sql<{ readonly plan_doc_id: string }>`
          SELECT plan_doc_id FROM ft3_board_card_plans
          WHERE planner_thread_id = ${caller.threadId}
        `.pipe(
          Effect.map((rows) => rows[0]?.plan_doc_id ?? null),
          Effect.orElseSucceed(() => null),
        );
        return { role: null, planStableId, granted: false };
      }),
    });
  }),
);
