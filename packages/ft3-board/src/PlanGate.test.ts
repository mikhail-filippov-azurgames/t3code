import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PlanGate from "./PlanGate.ts";
import * as PlanService from "./PlanService.ts";
import * as Testkit from "./planning.testkit.ts";

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
        { _tag: "Refuse", code: "plan_not_accepted" },
      );
    }
    assert.deepStrictEqual(
      PlanGate.decidePlanGate({ roleId: "test", plan: required("discussion"), liveSha256: SHA }),
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
        assert.equal(refusal.code, "plan_not_accepted");
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
});
