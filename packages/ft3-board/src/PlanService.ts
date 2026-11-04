// @effect-diagnostics nodeBuiltinImport:off - the plan template is a package asset read at runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import { ThreadId } from "@t3tools/contracts";
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
import * as Contracts from "./contracts.ts";
import * as PlanningContracts from "./planningContracts.ts";
import { countPlanSteps, validatePlan } from "./planValidation.ts";
const PLAN_TEMPLATE_URL = new URL("../assets/plan-template.md", import.meta.url);

export const PlanErrorCode = Schema.Literals([
  "planning_disabled",
  "plan_card_not_found",
  "plan_not_found",
  "plan_transition_invalid",
  "plan_review_rounds_exhausted",
  "plan_changed",
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
    /** The plan document a planner thread may write; null for any other thread. */
    readonly planStableIdOfPlannerThread: (
      threadId: string,
    ) => Effect.Effect<string | null, PlanError>;
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

const make = Effect.fn("PlanService.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const docs = yield* DocsServer.DocsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const gate = yield* FeatureGate.FeatureGate;
  const serverSettings = yield* ServerSettingsService;
  // Snapshot of the setting at layer build, like the docs root: an id-addressed
  // plan survives a folder change, only new plan documents land in the new folder.
  const plansFolder = readDocsSettings(
    (yield* serverSettings.getSettings.pipe(Effect.orDie)).ft3,
  ).plansFolder;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storeFailure = (cardId: string) => (cause: unknown) =>
    new PlanError({ code: "plan_store_failed", cardId, cause });
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

  const readTemplate = (cardId: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.readFile(NodeURL.fileURLToPath(PLAN_TEMPLATE_URL), "utf8"),
      catch: (cause) => new PlanError({ code: "plan_document_failed", cardId, cause }),
    });

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
    const template = yield* readTemplate(cardId);
    const written = yield* docs
      .write({
        caller: {
          threadId: orchestratorId,
          parentThreadId: shell.lineage.parentThreadId,
        },
        relPath: `${plansFolder}/${slug}/${cardId}.md`,
        content: renderPlan(template, cardId, title),
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

  const submitForDiscussion = Effect.fn("PlanService.submitForDiscussion")(function* (
    cardId: Contracts.BoardCardId,
  ) {
    const record = yield* loadRecord(cardId);
    yield* requireState(record, ["drafting", "accepted"]);
    const doc = yield* readPlanDocument(record);
    const next = { ...record, state: "discussion" as const, updatedAt: yield* nowIso };
    yield* commit(next, { phase: "discussion", sha256: doc.sha256, content: doc.content });
    return next;
  });

  const accept = Effect.fn("PlanService.accept")(function* (input: {
    readonly cardId: Contracts.BoardCardId;
    readonly sha256: string;
  }) {
    const record = yield* loadRecord(input.cardId);
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
    yield* commit(next, { phase: "accepted", sha256: doc.sha256, content: doc.content });
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

  /** Step counts by plan document, keyed by the digest the count was parsed from. */
  const stepCounts = yield* Ref.make(
    new Map<string, { fingerprint: string; sha256: string; stepCount: number }>(),
  );

  /**
   * Cards with at least one plan.phase=implement letter on their mail task.
   * The mail tables live in the same database; one batched read, no package
   * dependency.
   */
  const queryImplementedCardIds = Effect.fn("PlanService.implementedCardIds")(function* (
    cardIds: ReadonlyArray<string>,
  ) {
    if (cardIds.length === 0) return new Set<string>();
    // Board-only compositions (tests, MCP) never migrate the mail tables;
    // without them no implement letter can exist.
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('ft3_mail_tasks', 'ft3_mail_letters')
    `;
    if (tables.length < 2) return new Set<string>();
    const rows = yield* sql<{ readonly card_id: string }>`
      SELECT DISTINCT t.card_id
      FROM ft3_mail_tasks AS t
      JOIN ft3_mail_letters AS l ON l.task_id = t.task_id
      WHERE t.card_id IN ${sql.in(cardIds)} AND l.plan_phase = 'implement'
    `;
    return new Set(rows.map((row) => row.card_id));
  });
  const implementedCardIds = (cardIds: ReadonlyArray<string>) =>
    queryImplementedCardIds(cardIds).pipe(Effect.mapError(storeFailure("")));

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
    readonly title: string;
  }

  const summaryOf = Effect.fn("PlanService.planSummary")(function* (
    row: SummaryRow,
    implementStarted: boolean,
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
    if (document === null) {
      yield* Ref.update(stepCounts, (cache) => {
        const next = new Map(cache);
        next.delete(row.plan_doc_id);
        return next;
      });
      return summarize(0);
    }
    const stepCount =
      cached !== undefined && cached.sha256 === document.sha256
        ? cached.stepCount
        : countPlanSteps(document.content);
    yield* Ref.update(stepCounts, (cache) =>
      new Map(cache).set(row.plan_doc_id, {
        fingerprint: stamp,
        sha256: document.sha256,
        stepCount,
      }),
    );
    return summarize(stepCount);
  });

  const listSummaries = Effect.fn("PlanService.listSummaries")(function* (input: {
    readonly cardIds: ReadonlyArray<Contracts.BoardCardId>;
  }) {
    if (input.cardIds.length === 0) return [];
    const rows = yield* sql<SummaryRow>`
      SELECT p.card_id, p.state, p.plan_doc_id, p.planner_thread_id, c.title
      FROM ft3_board_card_plans AS p
      JOIN ft3_board_cards AS c ON c.card_id = p.card_id
      WHERE p.card_id IN ${sql.in(input.cardIds)}
      ORDER BY p.card_id
    `.pipe(Effect.mapError(storeFailure("")));
    if (rows.length === 0) return [];
    const cardIds = rows.map((row) => row.card_id);
    const implemented = yield* implementedCardIds(cardIds);
    return yield* Effect.forEach(rows, (row) => summaryOf(row, implemented.has(row.card_id)), {
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
    planStableIdOfPlannerThread,
    listSummaries,
  });
});

export const planServiceLayer = Layer.effect(PlanService, make());

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
