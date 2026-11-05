import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PlanGate from "./PlanGate.ts";
import * as PlanService from "./PlanService.ts";
import * as Testkit from "./planning.testkit.ts";

describe("PlanGate phase matrix", () => {
  const open = { required: true, state: "drafting" as const, acceptedSha256: null };
  const accepted = { required: true, state: "accepted" as const, acceptedSha256: "abc" };

  it("lets ungated roles and unrequired cards through", () => {
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "researcher", plan: open, liveSha256: null }),
      { _tag: "Allow" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "implementation", plan: null, liveSha256: null }),
      { _tag: "Allow" },
    );
  });

  it("requires a phase once the plan is required", () => {
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "implementation", plan: open, liveSha256: null }),
      { _tag: "Refuse", code: "plan_phase_required" },
    );
  });

  it("allows draft, review, and worktree prototype while the plan is open", () => {
    for (const phase of ["draft", "review"] as const) {
      assert.deepStrictEqual(
        PlanGate.decidePlanGate({ roleId: "implementation", plan: open, liveSha256: null, phase }),
        { _tag: "Allow" },
      );
    }
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "implementation",
        plan: open,
        liveSha256: null,
        phase: "prototype",
        isolation: "worktree",
      }),
      { _tag: "Allow" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "implementation",
        plan: open,
        liveSha256: null,
        phase: "prototype",
      }),
      { _tag: "Refuse", code: "plan_phase_invalid" },
    );
  });

  it("refuses prototype once the plan is accepted, whatever the isolation", () => {
    for (const isolation of ["worktree", null] as const) {
      assert.deepStrictEqual(
        PlanGate.decidePlanGate({
          roleId: "implementation",
          plan: accepted,
          liveSha256: "abc",
          phase: "prototype",
          isolation,
        }),
        { _tag: "Refuse", code: "plan_phase_invalid" },
      );
    }
  });

  it("refuses implement before accept", () => {
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "implementation",
        plan: open,
        liveSha256: null,
        phase: "implement",
      }),
      { _tag: "Refuse", code: "plan_not_accepted" },
    );
  });

  it("refuses a changed plan and checks the implement step", () => {
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "implementation", plan: accepted, liveSha256: "zzz" }),
      { _tag: "Refuse", code: "plan_changed" },
    );
    const base = {
      roleId: "implementation",
      plan: accepted,
      liveSha256: "abc",
      phase: "implement" as const,
    };
    assert.deepStrictEqual(PlanGate.decidePlanGate({ ...base, acceptedStepIds: ["P1"] }), {
      _tag: "Refuse",
      code: "plan_phase_invalid",
    });
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ ...base, step: "P9", acceptedStepIds: ["P1"] }),
      { _tag: "Refuse", code: "plan_step_unknown" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ ...base, step: "P1", acceptedStepIds: ["P1", "P2"] }),
      { _tag: "Allow" },
    );
  });
});

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const required = (
  state: "required" | "discussion" | "accepted",
  acceptedSha256: string | null = null,
) => ({
  required: true,
  state,
  acceptedSha256,
});

describe("decidePlanGate", () => {
  it("gates implementation, general and test work on a card whose plan is not accepted", () => {
    for (const roleId of PlanGate.PLAN_GATED_ROLE_IDS) {
      assert.deepStrictEqual(
        PlanGate.decidePlanGate({ roleId, plan: required("required"), liveSha256: null }),
        { _tag: "Refuse", code: "plan_phase_required" },
      );
      assert.deepStrictEqual(
        PlanGate.decidePlanGate({
          roleId,
          plan: required("required"),
          liveSha256: null,
          phase: "implement",
        }),
        { _tag: "Refuse", code: "plan_not_accepted" },
      );
    }
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "test", plan: required("discussion"), liveSha256: SHA }),
      { _tag: "Refuse", code: "plan_phase_required" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "test",
        plan: required("discussion"),
        liveSha256: SHA,
        phase: "implement",
      }),
      { _tag: "Refuse", code: "plan_not_accepted" },
    );
  });

  it("leaves research, review and planner work ungated and cards without a requirement open", () => {
    for (const roleId of ["research", "review-common", "architect", "planner"]) {
      assert.deepStrictEqual(
        PlanGate.decidePlanGate({ roleId, plan: required("required"), liveSha256: null }),
        { _tag: "Allow" },
      );
    }
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "implementation", plan: null, liveSha256: null }),
      { _tag: "Allow" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "implementation",
        plan: { required: false, state: "withdrawn", acceptedSha256: null },
        liveSha256: null,
      }),
      { _tag: "Allow" },
    );
  });

  it("allows gated work only while the live plan is the accepted digest", () => {
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "general",
        plan: required("accepted", SHA),
        liveSha256: SHA,
      }),
      { _tag: "Allow" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "general",
        plan: required("accepted", SHA),
        liveSha256: OTHER_SHA,
      }),
      { _tag: "Refuse", code: "plan_changed" },
    );
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({
        roleId: "general",
        plan: required("accepted", SHA),
        liveSha256: null,
      }),
      { _tag: "Refuse", code: "plan_changed" },
    );
  });
});

describe("PlanGate layer", () => {
  it.effect("reads the live plan and refuses gated work until the plan is accepted", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const plans = yield* PlanService.PlanService;
        const gate = yield* PlanGate.PlanGate;
        const record = yield* plans.require({ cardId: Testkit.CARD_ID, requiredBy: "lead" });
        const refusal = yield* gate
          .check({ cardId: Testkit.CARD_ID, roleId: "implementation" })
          .pipe(Effect.flip);
        assert.equal(refusal.code, "plan_phase_required");
        const implement = yield* gate
          .check({ cardId: Testkit.CARD_ID, roleId: "implementation", phase: "implement" })
          .pipe(Effect.flip);
        assert.equal(implement.code, "plan_not_accepted");
        yield* gate.check({ cardId: Testkit.CARD_ID, roleId: "research" });

        yield* plans.beginDraft(Testkit.CARD_ID);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* plans.submitForDiscussion(Testkit.CARD_ID);
        const sha256 = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
        yield* plans.accept({ cardId: Testkit.CARD_ID, sha256 });
        yield* gate.check({ cardId: Testkit.CARD_ID, roleId: "implementation" });

        yield* Testkit.editPlan(
          record.planDocId,
          `${Testkit.validPlan(record.planDocId)}\nLater edit.\n`,
        );
        const changed = yield* gate
          .check({ cardId: Testkit.CARD_ID, roleId: "implementation" })
          .pipe(Effect.flip);
        assert.equal(changed.code, "plan_changed");
      }),
    ),
  );

  it.effect("records letter effects: draft requires, review opens a round, implement starts", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const plans = yield* PlanService.PlanService;
        const gate = yield* PlanGate.PlanGate;
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "draft" });
        assert.equal((yield* plans.get(Testkit.CARD_ID))?.state, "drafting");
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "review" });
        assert.equal((yield* plans.get(Testkit.CARD_ID))?.reviewRounds, 1);
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "implement" });
        const summaries = yield* plans.listSummaries({ cardIds: [Testkit.CARD_ID] });
        assert.isTrue(summaries[0]?.implementStarted);
      }),
    ),
  );

  it.effect("walks flag, draft, answer, review and discussion through the letter effects", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const plans = yield* PlanService.PlanService;
        const gate = yield* PlanGate.PlanGate;
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "draft" });
        const record = yield* plans.require({ cardId: Testkit.CARD_ID, requiredBy: "lead" });
        assert.isNull(yield* gate.plannerThreadOf(Testkit.CARD_ID));
        yield* gate.bindPlannerThread({
          cardId: Testkit.CARD_ID,
          threadId: Testkit.PLANNER_THREAD_ID,
        });
        assert.equal(yield* gate.plannerThreadOf(Testkit.CARD_ID), Testkit.PLANNER_THREAD_ID);
        yield* Testkit.editPlan(record.planDocId, Testkit.validPlan(record.planDocId));
        yield* gate.recordPlannerAnswer({ cardId: Testkit.CARD_ID });
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "review" });
        assert.equal((yield* plans.get(Testkit.CARD_ID))?.state, "reviewing");
        yield* plans.submitForDiscussion(Testkit.CARD_ID);
        assert.equal((yield* plans.get(Testkit.CARD_ID))?.state, "discussion");
        const phases = (yield* plans.listVersions(Testkit.CARD_ID)).map((version) => version.phase);
        assert.deepStrictEqual(phases.toSorted(), ["discussion", "draft"]);
      }),
    ),
  );

  it.effect("closes the review round when changes go back to the planner", () =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        yield* Testkit.seedCard();
        const plans = yield* PlanService.PlanService;
        const gate = yield* PlanGate.PlanGate;
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "draft" });
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "review" });
        yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "draft" });
        const record = yield* plans.get(Testkit.CARD_ID);
        assert.equal(record?.state, "drafting");
        assert.equal(record?.reviewRounds, 1);
        const phases = (yield* plans.listVersions(Testkit.CARD_ID)).map((version) => version.phase);
        assert.deepStrictEqual(phases, ["review_1"]);
      }),
    ),
  );

  it.effect(
    "persists implementStarted at record time, surviving a purge with no list in between",
    () =>
      Testkit.withPlanning(
        Effect.gen(function* () {
          yield* Testkit.seedCard();
          const plans = yield* PlanService.PlanService;
          const gate = yield* PlanGate.PlanGate;
          yield* plans.require({ cardId: Testkit.CARD_ID, requiredBy: "lead" });
          // What MailService records at send time for a plan.phase=implement
          // letter. Retention purges the mail rows before any list runs; the
          // default facts report no mail, as if the tables were gone.
          yield* gate.recordPlanLetter({ cardId: Testkit.CARD_ID, phase: "implement" });
          const summaries = yield* plans.listSummaries({ cardIds: [Testkit.CARD_ID] });
          assert.isTrue(summaries[0]?.implementStarted);
        }),
      ),
  );
});
