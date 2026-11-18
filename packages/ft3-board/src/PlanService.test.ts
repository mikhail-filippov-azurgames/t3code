import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { docLinkOf } from "@t3tools/ft3-docs/contracts";
import * as DocsServer from "@t3tools/ft3-docs/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as BoardMailFacts from "./boardMailFacts.ts";
import * as Contracts from "./contracts.ts";
import * as PlanService from "./PlanService.ts";
import { boardRpcHandlers, FT3_BOARD_WS_METHODS } from "./rpc.ts";
import * as Testkit from "./planning.testkit.ts";

// The bundled server ships no assets/ directory, so the plan template must never be read from disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith("plan-template.md"))
        return Promise.reject(new Error("ENOENT: plan-template.md"));
      return actual.readFile(...args);
    },
  };
});

const cardId = Testkit.CARD_ID;
const plans = PlanService.PlanService;

/**
 * A mail-facts fake whose implement set the test rewrites mid-run: emptying
 * it models the retention purge deleting the mail rows.
 */
const mailFactsCell = (initial: ReadonlySet<string>) => {
  const implemented = { current: new Set(initial) };
  const layer = Layer.succeed(
    BoardMailFacts.BoardMailFacts,
    BoardMailFacts.BoardMailFacts.of({
      hasImplementLetter: (cardIds) =>
        Effect.succeed(new Set([...cardIds].filter((id) => implemented.current.has(id)))),
      hasOpenMailWork: () => Effect.succeed(false),
    }),
  );
  return { layer, implemented };
};

const versionPhases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly phase: string;
  }>`SELECT phase FROM ft3_board_plan_versions WHERE card_id = ${cardId} ORDER BY phase`;
  return rows.map((row) => row.phase);
});

describe("PlanService", () => {
  it.effect("gates plan RPCs by the card lead project and falls back for unresolved leads", () => {
    const otherCardId = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000002");
    const unresolvedCardId = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000003");
    const boardOffCardId = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000004");
    const otherLeadId = ThreadId.make("thread:other-lead");
    const unresolvedLeadId = ThreadId.make("thread:unresolved-lead");
    const boardOffLeadId = ThreadId.make("thread:board-off-lead");
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard("Disabled project", cardId);
        yield* Testkit.seedCard("Enabled project", otherCardId, otherLeadId);
        yield* Testkit.seedCard("Unresolved lead", unresolvedCardId, unresolvedLeadId);
        yield* Testkit.seedCard("Board disabled", boardOffCardId, boardOffLeadId);
        const service = yield* plans;

        const disabled = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardPlanGet]({
          cardId,
        }).pipe(Effect.flip);
        assert.equal(disabled.code, "feature_disabled");
        const boardDisabled = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardStart]({
          cardId: boardOffCardId,
        }).pipe(Effect.flip);
        assert.equal(boardDisabled.code, "feature_disabled");

        const enabledPlan = yield* service.require({ cardId: otherCardId, requiredBy: "human" });
        const enabled = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardPlanGet]({
          cardId: otherCardId,
        });
        assert.equal(enabled.record.planDocId, enabledPlan.planDocId);

        const resetDisabled = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardPlanSetRequired]({
          cardId,
          required: false,
        }).pipe(Effect.flip);
        assert.equal(resetDisabled.code, "feature_disabled");
        const acceptDisabled = yield* boardRpcHandlers[FT3_BOARD_WS_METHODS.boardPlanAccept]({
          cardId,
          sha256: "0".repeat(64),
        }).pipe(Effect.flip);
        assert.equal(acceptDisabled.code, "feature_disabled");

        yield* service.requirePlanningEnabled(unresolvedCardId);
      }),
      {
        threadProjects: {
          [Testkit.LEAD_THREAD_ID]: "project:planning-off",
          [otherLeadId]: "project:planning-on",
          [boardOffLeadId]: "project:board-off",
        },
        projectFeatureOverrides: {
          "project:planning-off": { planning: false },
          "project:board-off": { board: false },
        },
        unresolvedThreads: new Set([String(unresolvedLeadId)]),
      },
    );
  });

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
        // readFile is mocked to fail for the template: the bundled server has no asset file.
        assert.include(document.content, "## Risks and rollback");
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

  it.effect("keeps the cards and their known implement flags when the implement lookup fails", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const otherCardId = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000002");
        yield* Testkit.seedCard("Other plan", otherCardId);
        const service = yield* plans;
        yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.require({ cardId: otherCardId, requiredBy: "lead" });
        yield* service.markImplementStarted(cardId);
        const summaries = yield* service.listSummaries({ cardIds: [cardId, otherCardId] });
        const flagOf = (id: Contracts.BoardCardId) =>
          summaries.find((summary) => summary.cardId === id)?.implementStarted;
        assert.equal(summaries.length, 2);
        assert.isTrue(flagOf(cardId));
        assert.isNull(flagOf(otherCardId));
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly implement_started_at: string | null }>`
          SELECT implement_started_at FROM ft3_board_card_plans WHERE card_id = ${otherCardId}`;
        assert.isNull(rows[0]?.implement_started_at);
      }),
      {
        mailFacts: Layer.succeed(
          BoardMailFacts.BoardMailFacts,
          BoardMailFacts.BoardMailFacts.of({
            hasImplementLetter: () =>
              Effect.fail(
                new BoardMailFacts.BoardMailFactsError({
                  operation: "hasImplementLetter",
                  cause: "database is locked",
                }),
              ),
            hasOpenMailWork: () => Effect.succeed(false),
          }),
        ),
      },
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

  it.effect("marks the summary implemented once an implement letter exists", () => {
    const mail = mailFactsCell(new Set([cardId]));
    return Testkit.withPlanning(
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
          [true, false],
        );
      }),
      { mailFacts: mail.layer },
    );
  });

  it.effect("keeps implementStarted after the implement letters are purged", () => {
    const mail = mailFactsCell(new Set([cardId]));
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard("Storage plan");
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        // The first list backfills the persisted flag from the mail facts, as
        // with implement letters written before the send-time flag existed.
        assert.deepStrictEqual(
          (yield* service.listSummaries({ cardIds: [cardId] })).map(
            (summary) => summary.implementStarted,
          ),
          [true],
        );
        // Retention purges the finished task and its letters; the facts go
        // empty but the persisted flag stays.
        mail.implemented.current = new Set();
        assert.deepStrictEqual(
          (yield* service.listSummaries({ cardIds: [cardId] })).map(
            (summary) => summary.implementStarted,
          ),
          [true],
        );
        const sql = yield* SqlClient.SqlClient;
        assert.isNotNull(
          (yield* sql<{ readonly implement_started_at: string | null }>`
              SELECT implement_started_at FROM ft3_board_card_plans WHERE card_id = ${cardId}
            `)[0]?.implement_started_at,
        );
      }),
      { mailFacts: mail.layer },
    );
  });

  it("evicts the oldest step counts past the cap and refreshes recency in place", () => {
    const cache = new Map<string, PlanService.StepCountEntry>();
    const entry = (n: number): PlanService.StepCountEntry => ({
      fingerprint: `fp${n}`,
      sha256: `sha${n}`,
      stepCount: n,
    });
    PlanService.storeStepCount(cache, "a", entry(1), 2);
    PlanService.storeStepCount(cache, "b", entry(2), 2);
    PlanService.storeStepCount(cache, "c", entry(3), 2);
    assert.deepStrictEqual([...cache.keys()], ["b", "c"]);
    PlanService.storeStepCount(cache, "b", entry(20), 2);
    PlanService.storeStepCount(cache, "d", entry(4), 2);
    assert.deepStrictEqual([...cache.keys()], ["b", "d"]);
    assert.equal(cache.get("b")?.stepCount, 20);
  });

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

  const outageDispatch = () => {
    const dispatched: Array<unknown> = [];
    const state = { down: true };
    const options = {
      onDispatch: (command: unknown) => {
        if (state.down) throw new Error("dispatch down");
        dispatched.push(command);
      },
    };
    return { dispatched, state, options };
  };

  it.effect("redelivers the accepted event on an accept retry after a dispatch failure", () => {
    const outage = outageDispatch();
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const exit = yield* Effect.exit(service.accept({ cardId, sha256 }));
        assert.isTrue(Exit.isFailure(exit));
        assert.equal((yield* service.get(cardId))?.state, "accepted");
        const retryWhileDown = yield* Effect.exit(service.accept({ cardId, sha256 }));
        assert.isTrue(Exit.isFailure(retryWhileDown));
        assert.isEmpty(outage.dispatched);
        outage.state.down = false;
        const retry = yield* service.accept({ cardId, sha256 });
        assert.equal(retry.state, "accepted");
        assert.lengthOf(outage.dispatched, 1);
        yield* service.accept({ cardId, sha256 });
        assert.lengthOf(outage.dispatched, 1);
      }),
      outage.options,
    );
  });

  it.effect("redelivers the accepted event on restart without a retry, exactly once", () => {
    const outage = outageDispatch();
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        yield* Effect.exit(service.accept({ cardId, sha256 }));
        assert.isEmpty(outage.dispatched);
        yield* Testkit.restartAcceptDelivery(outage.options);
        assert.isEmpty(outage.dispatched);
        outage.state.down = false;
        yield* Testkit.restartAcceptDelivery(outage.options);
        assert.lengthOf(outage.dispatched, 1);
        yield* Testkit.restartAcceptDelivery(outage.options);
        assert.lengthOf(outage.dispatched, 1);
      }),
      outage.options,
    );
  });

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

  it.effect("marks the card needs_human on submit and ready on accept", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        const submitted = yield* service.submitForDiscussion(cardId);
        assert.equal(submitted.state, "discussion");
        const discussing = yield* sql<{
          readonly readiness: string;
          readonly readiness_note: string | null;
        }>`SELECT readiness, readiness_note FROM ft3_board_cards WHERE card_id = ${cardId}`;
        assert.equal(discussing[0]?.readiness, "needs_human");
        assert.isTrue((discussing[0]?.readiness_note ?? "").length > 0);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const accepted = yield* service.accept({ cardId, sha256 });
        assert.equal(accepted.state, "accepted");
        const decided = yield* sql<{
          readonly readiness: string;
          readonly readiness_note: string | null;
        }>`SELECT readiness, readiness_note FROM ft3_board_cards WHERE card_id = ${cardId}`;
        assert.equal(decided[0]?.readiness, "ready");
        assert.isNull(decided[0]?.readiness_note ?? null);
      }),
    ),
  );

  it.effect("resubmitting an unchanged plan succeeds without a new version", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const discussionVersions = Effect.gen(function* () {
          const rows = yield* sql<{ readonly sha256: string }>`
            SELECT sha256 FROM ft3_board_plan_versions
            WHERE card_id = ${cardId} AND phase = 'discussion'`;
          return rows;
        });
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        const first = yield* service.submitForDiscussion(cardId);
        assert.equal(first.state, "discussion");
        assert.equal((yield* discussionVersions).length, 1);
        const second = yield* service.submitForDiscussion(cardId);
        assert.equal(second.state, "discussion");
        assert.equal((yield* discussionVersions).length, 1);
        const edited = Testkit.validPlan(record.planDocId).replace(
          "| P1 | add the table | ft3-board | migration test |",
          "| P1 | add the table | ft3-board | migration test |\n| P2 | wire the gate | ft3-board | gate test |",
        );
        yield* Testkit.editPlan(record.planDocId, edited);
        const third = yield* service.submitForDiscussion(cardId);
        assert.equal(third.state, "discussion");
        assert.equal((yield* discussionVersions).length, 2);
      }),
    ),
  );

  const duplicatedStepPlan = (planDocId: string) =>
    Testkit.validPlan(planDocId).replace(
      "| P1 | add the table | ft3-board | migration test |",
      "| P1 | add the table | ft3-board | migration test |\n| P1 | again | ft3-board | migration test |",
    );

  const dispatched: Array<unknown> = [];

  it.effect("refuses a retried accept once the accepted document has changed", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        yield* service.accept({ cardId, sha256 });
        yield* Testkit.editPlan(
          record.planDocId,
          `${Testkit.validPlan(record.planDocId)}\nLater edit.\n`,
        );
        const error = yield* service.accept({ cardId, sha256 }).pipe(Effect.flip);
        assert.equal(error.code, "plan_changed");
        assert.equal((yield* service.get(cardId))?.acceptedRevision, 1);
      }),
    ),
  );

  it.effect("accepting the same digest twice emits a single lead event", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const first = yield* service.accept({ cardId, sha256 });
        assert.equal(first.acceptedRevision, 1);
        const second = yield* service.accept({ cardId, sha256 });
        assert.equal(second.acceptedRevision, 1);
        assert.equal(second.state, "accepted");
        assert.lengthOf(dispatched, 1);
        const event = dispatched[0] as { readonly text?: unknown };
        assert.isString(event.text);
        assert.include(event.text as string, "Plan accepted for card");
        assert.include(event.text as string, record.planDocId);
        assert.include(event.text as string, "revision 1");
      }),
      { onDispatch: (command) => dispatched.push(command) },
    ),
  );

  it.effect("refuses an invalid plan and reports the line of the first problem", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        // Submit refuses an invalid plan, so the plan breaks while in discussion.
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        yield* Testkit.editPlan(record.planDocId, duplicatedStepPlan(record.planDocId));
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const error = yield* service.accept({ cardId, sha256 }).pipe(Effect.flip);
        assert.equal(error.code, "plan_invalid");
        assert.equal(error.line, 20);
        assert.include(error.reason ?? "", 'step id "P1" is repeated');
      }),
    ),
  );

  const cardReadiness = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly readiness: string | null;
      readonly readiness_note: string | null;
    }>`SELECT readiness, readiness_note FROM ft3_board_cards WHERE card_id = ${cardId}`;
    return rows[0];
  });

  it.effect("refuses to submit a plan whose step id is not P<n> and changes nothing", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        const nested = Testkit.validPlan(record.planDocId).replace("| P1 |", "| P1.1 |");
        yield* Testkit.editPlan(record.planDocId, nested);
        const readinessBefore = yield* cardReadiness;
        const error = yield* service.submitForDiscussion(cardId).pipe(Effect.flip);
        assert.equal(error.code, "plan_invalid");
        assert.equal(error.line, 19);
        assert.equal(error.reason, 'step id "P1.1" must look like P1');
        assert.equal((yield* service.get(cardId))?.state, "drafting");
        assert.deepStrictEqual(yield* cardReadiness, readinessBefore);
        assert.deepStrictEqual(yield* versionPhases, []);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        const submitted = yield* service.submitForDiscussion(cardId);
        assert.equal(submitted.state, "discussion");
        assert.equal((yield* cardReadiness)?.readiness, "needs_human");
        assert.deepStrictEqual(yield* versionPhases, ["discussion"]);
      }),
    ),
  );

  it.effect("refuses to resubmit a plan broken in discussion and keeps the last version", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        const first = yield* service.submitForDiscussion(cardId);
        const unchanged = yield* service.submitForDiscussion(cardId);
        assert.equal(unchanged.updatedAt, first.updatedAt);
        yield* Testkit.editPlan(record.planDocId, duplicatedStepPlan(record.planDocId));
        const error = yield* service.submitForDiscussion(cardId).pipe(Effect.flip);
        assert.equal(error.code, "plan_invalid");
        assert.include(error.reason ?? "", 'step id "P1" is repeated');
        assert.equal((yield* service.get(cardId))?.state, "discussion");
        assert.deepStrictEqual(yield* versionPhases, ["discussion"]);
      }),
    ),
  );

  /** Records lead events, failing every dispatch while `down` is set. */
  const leadEvents = () => {
    const events: Array<{
      readonly type?: string;
      readonly threadId?: string;
      readonly messageId?: string;
      readonly text?: string;
    }> = [];
    const state = { down: false };
    const options = {
      onDispatch: (command: unknown) => {
        if (state.down) throw new Error("dispatch down");
        events.push(command as (typeof events)[number]);
      },
    };
    const failures = () =>
      events.filter((event) => (event.text ?? "").startsWith("Plan acceptance failed"));
    return { events, failures, state, options };
  };

  it.effect("tells the lead when an accept of an invalid plan is refused", () => {
    const lead = leadEvents();
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard("Storage plan");
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        yield* Testkit.editPlan(record.planDocId, duplicatedStepPlan(record.planDocId));
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const error = yield* service.accept({ cardId, sha256 }).pipe(Effect.flip);
        assert.equal(error.code, "plan_invalid");
        const failures = lead.failures();
        assert.lengthOf(failures, 1);
        const event = failures[0]!;
        assert.equal(event.type, "message.dispatch");
        assert.equal(event.threadId, Testkit.LEAD_THREAD_ID);
        assert.equal(
          event.text,
          `Plan acceptance failed for card "Storage plan" (${cardId}): ${error.message}`,
        );
        assert.equal(
          event.messageId,
          `ft3:plan:accept-failed:${cardId}:${sha256.slice(0, 12)}:plan_invalid`,
        );
      }),
      lead.options,
    );
  });

  it.effect("tells the lead when an accept of a stale digest is refused, keyed for dedupe", () => {
    const lead = leadEvents();
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const stale = "0".repeat(64);
        const error = yield* service.accept({ cardId, sha256: stale }).pipe(Effect.flip);
        assert.equal(error.code, "plan_changed");
        yield* service.accept({ cardId, sha256: stale }).pipe(Effect.flip);
        const failures = lead.failures();
        assert.lengthOf(failures, 2);
        assert.equal(failures[0]?.threadId, Testkit.LEAD_THREAD_ID);
        assert.include(failures[0]?.text ?? "", error.message);
        assert.equal(failures[0]?.messageId, failures[1]?.messageId);
        assert.equal(
          failures[0]?.messageId,
          `ft3:plan:accept-failed:${cardId}:${stale.slice(0, 12)}:plan_changed`,
        );
      }),
      lead.options,
    );
  });

  it.effect("sends no failure event for an idempotent accept retry", () => {
    const lead = leadEvents();
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        yield* service.accept({ cardId, sha256 });
        const retry = yield* service.accept({ cardId, sha256 });
        assert.equal(retry.state, "accepted");
        assert.isEmpty(lead.failures());
        assert.lengthOf(lead.events, 1);
      }),
      lead.options,
    );
  });

  it.effect("keeps the refusal when the failure event cannot be dispatched", () => {
    const lead = leadEvents();
    lead.state.down = true;
    return Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const service = yield* plans;
        const record = yield* service.require({ cardId, requiredBy: "lead" });
        yield* service.beginDraft(cardId);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* service.submitForDiscussion(cardId);
        yield* Testkit.editPlan(record.planDocId, duplicatedStepPlan(record.planDocId));
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        const error = yield* service.accept({ cardId, sha256 }).pipe(Effect.flip);
        assert.equal(error.code, "plan_invalid");
        assert.include(error.reason ?? "", 'step id "P1" is repeated');
        assert.equal((yield* service.get(cardId))?.state, "discussion");
        assert.isEmpty(lead.events);
      }),
      lead.options,
    );
  });

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
