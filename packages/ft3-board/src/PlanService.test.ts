import { assert, describe, it } from "@effect/vitest";
import { docLinkOf } from "@t3tools/ft3-docs/contracts";
import * as DocsServer from "@t3tools/ft3-docs/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as Contracts from "./contracts.ts";
import * as PlanService from "./PlanService.ts";
import * as Testkit from "./planning.testkit.ts";

const cardId = Testkit.CARD_ID;
const plans = PlanService.PlanService;

const versionPhases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly phase: string;
  }>`SELECT phase FROM ft3_board_plan_versions WHERE card_id = ${cardId} ORDER BY phase`;
  return rows.map((row) => row.phase);
});

describe("PlanService", () => {
  it.effect("flags the card and writes its plan document at the plan path", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard("Storage plan");
        const service = yield* plans;
        const docs = yield* DocsServer.DocsService;
        const record = yield* service.require({ cardId, requiredBy: "lead", reason: "storage" });
        assert.equal(record.state, "required");
        assert.isTrue(record.required);
        assert.equal(record.requiredReason, "storage");
        const ref = yield* docs.docRef(docLinkOf(record.planDocId));
        assert.equal(ref.relPath, `corvis/plans/corvis-core/${cardId}.md`);
        const document = yield* docs.read({ ref: docLinkOf(record.planDocId) });
        assert.include(document.content, "schema: corvis-plan-v1");
        assert.include(document.content, `cardId: ${cardId}`);
        assert.include(document.content, "# Plan: Storage plan");
      }),
    ),
  );

  it.effect("names the plan folder by the project id when the title has no ASCII letters", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const docs = yield* DocsServer.DocsService;
        const record = yield* service.require({ cardId, requiredBy: "human" });
        const ref = yield* docs.docRef(docLinkOf(record.planDocId));
        assert.equal(ref.relPath, `corvis/plans/project-corvis/${cardId}.md`);
      }),
      { projectTitle: "Проект" },
    ),
  );

  it.effect("creates new plan documents under the configured plans folder", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const docs = yield* DocsServer.DocsService;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        const ref = yield* docs.docRef(docLinkOf(record.planDocId));
        assert.equal(ref.relPath, `teams/plans/corvis-core/${cardId}.md`);
      }),
      { plansFolder: "teams/plans" },
    ),
  );

  it.effect("lists one summary per planned card with its live step count", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard("Storage plan");
        const service = yield* plans;
        assert.deepStrictEqual(yield* service.listSummaries({ cardIds: [] }), []);
        assert.deepStrictEqual(yield* service.listSummaries({ cardIds: [cardId] }), []);
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.bindPlannerThread({ cardId, threadId: Testkit.PLANNER_THREAD_ID });
        const twoSteps = Testkit.validPlan(record.planDocId).replace(
          "| P1 | add the table | ft3-board | migration test |",
          "| P1 | add the table | ft3-board | migration test |\n| P2 | wire the gate | ft3-board | gate test |",
        );
        yield* Testkit.editPlan(record.planDocId, twoSteps);
        assert.deepStrictEqual(yield* service.listSummaries({ cardIds: [cardId] }), [
          {
            cardId,
            planDocId: record.planDocId,
            title: "Storage plan",
            status: "required",
            stepCount: 2,
            plannerThreadId: Testkit.PLANNER_THREAD_ID,
            implementStarted: false,
          },
        ]);
        yield* Testkit.editPlan(record.planDocId, "# Plan: Storage plan\n");
        assert.deepStrictEqual(
          (yield* service.listSummaries({ cardIds: [cardId] })).map((summary) => summary.stepCount),
          [0],
        );
      }),
    ),
  );

  it.effect("reads only the requested cards and skips unchanged docs on repeat", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const secondCardId = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000002");
        yield* Testkit.seedCard("Storage plan");
        yield* Testkit.seedCard("Second plan", secondCardId);
        const service = yield* plans;
        const reads = yield* Testkit.PlanDocsReads;
        const first = yield* service.require({ cardId, requiredBy: "lead" });
        const second = yield* service.require({ cardId: secondCardId, requiredBy: "lead" });
        yield* Testkit.editPlan(first.planDocId, Testkit.validPlan(first.planDocId));
        yield* Testkit.editPlan(
          second.planDocId,
          Testkit.validPlan(second.planDocId, "Second plan"),
        );
        const before = yield* Ref.get(reads);
        const filtered = yield* service.listSummaries({ cardIds: [cardId] });
        assert.deepStrictEqual(
          filtered.map((summary) => summary.cardId),
          [cardId],
        );
        assert.strictEqual(yield* Ref.get(reads), before + 1);
        const repeat = yield* service.listSummaries({ cardIds: [cardId, secondCardId] });
        assert.deepStrictEqual(
          repeat.map((summary) => summary.cardId),
          [cardId, secondCardId],
        );
        assert.strictEqual(yield* Ref.get(reads), before + 2);
        yield* service.listSummaries({ cardIds: [cardId, secondCardId] });
        assert.strictEqual(yield* Ref.get(reads), before + 2);
      }),
    ),
  );

  it.effect("marks the summary implemented once an implement letter exists", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const secondCardId = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000003");
        yield* Testkit.seedCard("Storage plan");
        yield* Testkit.seedCard("Second plan", secondCardId);
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        const other = yield* service.require({ cardId: secondCardId, requiredBy: "lead" });
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* Testkit.editPlan(other.planDocId, Testkit.validPlan(other.planDocId, "Second plan"));
        assert.deepStrictEqual(
          (yield* service.listSummaries({ cardIds: [cardId, secondCardId] })).map(
            (summary) => summary.implementStarted,
          ),
          [false, false],
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE IF NOT EXISTS ft3_mail_tasks (task_id TEXT NOT NULL PRIMARY KEY, card_id TEXT)`;
        yield* sql`CREATE TABLE IF NOT EXISTS ft3_mail_letters (letter_id TEXT NOT NULL PRIMARY KEY, task_id TEXT NOT NULL, plan_phase TEXT)`;
        yield* sql`INSERT INTO ft3_mail_tasks (task_id, card_id) VALUES ('task:implement', ${cardId})`;
        yield* sql`INSERT INTO ft3_mail_letters (letter_id, task_id, plan_phase) VALUES ('letter:discussion-1', 'task:implement', 'discussion')`;
        assert.deepStrictEqual(
          (yield* service.listSummaries({ cardIds: [cardId, secondCardId] })).map(
            (summary) => summary.implementStarted,
          ),
          [false, false],
        );
        yield* sql`INSERT INTO ft3_mail_letters (letter_id, task_id, plan_phase) VALUES ('letter:implement-1', 'task:implement', 'implement')`;
        assert.deepStrictEqual(
          (yield* service.listSummaries({ cardIds: [cardId, secondCardId] })).map(
            (summary) => summary.implementStarted,
          ),
          [true, false],
        );
      }),
    ),
  );

  it.effect("refuses to flag a card while planning is off and creates nothing", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const error = yield* service.require({ cardId, requiredBy: "human" }).pipe(Effect.flip);
        assert.equal(error.code, "planning_disabled");
        assert.isNull(yield* service.get(cardId));
      }),
      { planning: false },
    ),
  );

  it.effect("refuses to flag a card that does not exist", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const service = yield* plans;
        const error = yield* service.require({ cardId, requiredBy: "human" }).pipe(Effect.flip);
        assert.equal(error.code, "plan_card_not_found");
      }),
    ),
  );

  it.effect("denies the plan document when the card's lead is itself a child", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const error = yield* service.require({ cardId, requiredBy: "lead" }).pipe(Effect.flip);
        assert.equal(error.code, "plan_document_denied");
        assert.isNull(yield* service.get(cardId));
      }),
      { childLead: true },
    ),
  );

  it.effect("returns the existing plan when a flagged card is flagged again", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const first = yield* service.require({ cardId, requiredBy: "lead" });
        const second = yield* service.require({ cardId, requiredBy: "human" });
        assert.equal(second.planDocId, first.planDocId);
        assert.equal(second.requiredBy, "lead");
      }),
    ),
  );

  it.effect("withdraws the requirement and reopens the same plan on a new flag", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const first = yield* service.require({ cardId, requiredBy: "lead" });
        const withdrawn = yield* service.withdraw(cardId);
        assert.isFalse(withdrawn.required);
        assert.equal(withdrawn.state, "withdrawn");
        const reopened = yield* service.require({ cardId, requiredBy: "human" });
        assert.equal(reopened.state, "required");
        assert.equal(reopened.planDocId, first.planDocId);
      }),
    ),
  );

  it.effect("caps review rounds at two", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* service.openReviewRound(cardId);
        yield* service.closeReviewRound(cardId);
        yield* service.openReviewRound(cardId);
        yield* service.closeReviewRound(cardId);
        const error = yield* service.openReviewRound(cardId).pipe(Effect.flip);
        assert.equal(error.code, "plan_review_rounds_exhausted");
        const record = yield* service.get(cardId);
        assert.equal(record?.reviewRounds, 2);
      }),
    ),
  );

  it.effect("refuses transitions outside the flow", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        yield* service.require({ cardId, requiredBy: "lead" });
        const review = yield* service.openReviewRound(cardId).pipe(Effect.flip);
        assert.equal(review.code, "plan_transition_invalid");
        const accept = yield* service.accept({ cardId, sha256: "0".repeat(64) }).pipe(Effect.flip);
        assert.equal(accept.code, "plan_transition_invalid");
      }),
    ),
  );

  it.effect("records each review and discussion step as a plan version", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.recordDraft(cardId);
        yield* service.openReviewRound(cardId);
        yield* service.closeReviewRound(cardId);
        yield* service.submitForDiscussion(cardId);
        assert.deepStrictEqual(yield* versionPhases, ["discussion", "draft", "review_1"]);
      }),
    ),
  );

  it.effect("accepts the digest the human saw and counts accepted revisions", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const accepted = yield* service.accept({ cardId, sha256 });
        assert.equal(accepted.state, "accepted");
        assert.equal(accepted.acceptedSha256, sha256);
        assert.equal(accepted.acceptedRevision, 1);
        yield* service.submitForDiscussion(cardId);
        const again = yield* service.accept({ cardId, sha256 });
        assert.equal(again.acceptedRevision, 2);
      }),
    ),
  );

  it.effect("refuses to accept a digest that is no longer the live plan", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const error = yield* service.accept({ cardId, sha256: "0".repeat(64) }).pipe(Effect.flip);
        assert.equal(error.code, "plan_changed");
        assert.equal((yield* service.get(cardId))?.state, "discussion");
      }),
    ),
  );

  it.effect("refuses an invalid plan and reports the line of the first problem", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        const duplicated = Testkit.validPlan(record.planDocId).replace(
          "| P1 | add the table | ft3-board | migration test |",
          "| P1 | add the table | ft3-board | migration test |\n| P1 | again | ft3-board | migration test |",
        );
        yield* Testkit.editPlan(record.planDocId, duplicated);
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const error = yield* service.accept({ cardId, sha256 }).pipe(Effect.flip);
        assert.equal(error.code, "plan_invalid");
        assert.equal(error.line, 20);
        assert.include(error.reason ?? "", 'step id "P1" is repeated');
      }),
    ),
  );

  it.effect("finds the plan of a bound planner thread and of no other thread", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.bindPlannerThread({ cardId, threadId: Testkit.PLANNER_THREAD_ID });
        assert.equal(
          yield* service.planStableIdOfPlannerThread(Testkit.PLANNER_THREAD_ID),
          record.planDocId,
        );
        assert.isNull(yield* service.planStableIdOfPlannerThread(Testkit.LEAD_THREAD_ID));
      }),
    ),
  );

  it.effect("grants a planner thread write facts for its own plan only", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const facts = yield* DocsServer.DocumentsWriteFactsPort;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.bindPlannerThread({ cardId, threadId: Testkit.PLANNER_THREAD_ID });
        const planner = {
          threadId: Testkit.PLANNER_THREAD_ID,
          parentThreadId: Testkit.LEAD_THREAD_ID,
        };
        const decision = DocsServer.resolveDocumentsWrite(planner, yield* facts.factsOf(planner));
        assert.deepStrictEqual(decision, {
          _tag: "Allow",
          scope: "document",
          stableId: record.planDocId,
          reason: "planner_plan",
        });
        const lead = { threadId: Testkit.LEAD_THREAD_ID, parentThreadId: null };
        assert.isNull((yield* facts.factsOf(lead)).planStableId);
      }),
    ),
  );

  it.effect("reads the planner's plan identity from the plan table alone", () =>
    Testkit.withPlanning(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Testkit.seedCard();
          const service = yield* plans;
          const record = yield* service.require({ cardId, requiredBy: "lead" });
          yield* service.bindPlannerThread({ cardId, threadId: Testkit.PLANNER_THREAD_ID });
          const sql = yield* SqlClient.SqlClient;
          const context = yield* Layer.build(
            PlanService.planningDocumentsWriteFactsSql.pipe(
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          );
          const facts = Context.get(context, DocsServer.DocumentsWriteFactsPort);
          const planner = {
            threadId: Testkit.PLANNER_THREAD_ID,
            parentThreadId: Testkit.LEAD_THREAD_ID,
          };
          assert.deepStrictEqual(yield* facts.factsOf(planner), {
            role: null,
            planStableId: record.planDocId,
            granted: false,
          });
          const stranger = { threadId: "thread:stranger", parentThreadId: "thread:lead" };
          assert.deepStrictEqual(yield* facts.factsOf(stranger), {
            role: null,
            planStableId: null,
            granted: false,
          });
        }),
      ),
    ),
  );

  it.effect("removes the plan record and its versions with the card", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM ft3_board_cards WHERE card_id = ${cardId}`;
        assert.isNull(yield* service.get(cardId));
        assert.deepStrictEqual(yield* versionPhases, []);
      }),
    ),
  );

  it.effect("the store rejects a plan state outside the design set", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const sql = yield* SqlClient.SqlClient;
        const error =
          yield* sql`INSERT INTO ft3_board_card_plans (card_id, required, required_by, state, plan_doc_id, review_rounds, accepted_revision, updated_at) VALUES (${cardId}, 1, 'lead', 'done', 'doc', 0, 0, '2026-10-26T00:00:00.000Z')`.pipe(
            Effect.flip,
          );
        assert.isDefined(error);
      }),
    ),
  );
});
