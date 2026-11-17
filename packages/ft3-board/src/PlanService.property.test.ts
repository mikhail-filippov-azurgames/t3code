import { assert, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as PlanService from "./PlanService.ts";
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
// A fixed seed keeps every run reproducible; the replay token of a failure pins it further.
const SEED = 20261117;
const options = (runs: number) => ({ arbitrary: { runs, seed: SEED } });

const literal = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const stepRows = Arbitrary.array(literal(["cache", "index", "gate", "panel", "probe"]), {
  minLength: 1,
  maxLength: 3,
});
/** A valid plan whose step table carries `extra` rows; distinct rows give distinct content. */
const planWith = (planDocId: string, extra: ReadonlyArray<string>) =>
  Testkit.validPlan(planDocId).replace(
    "| P1 | add the table | ft3-board | migration test |",
    [
      "| P1 | add the table | ft3-board | migration test |",
      ...extra.map((word, index) => `| P${index + 2} | ${word} | ft3-board | ${word} test |`),
    ].join("\n"),
  );

const discussionVersions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM ft3_board_plan_versions
    WHERE card_id = ${cardId} AND phase = 'discussion'`;
  return Number(rows[0]?.n ?? 0);
});

const submitted = (content: (planDocId: string) => string) =>
  Effect.gen(function* () {
    yield* Testkit.seedCard();
    const service = yield* PlanService.PlanService;
    const record = yield* service.require({ cardId, requiredBy: "lead" });
    yield* service.beginDraft(cardId);
    yield* Testkit.editPlan(record.planDocId, content(record.planDocId));
    yield* service.submitForDiscussion(cardId);
    const shown = (yield* Testkit.liveSha256Of(record.planDocId)) ?? "";
    return { service, planDocId: record.planDocId, shown };
  });

it.effect.prop(
  "accepts only the shown digest: any edit after submit makes it plan_changed",
  { edit: stepRows, resubmit: Schema.Boolean },
  ({ edit, resubmit }) =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const { service, planDocId, shown } = yield* submitted((id) => Testkit.validPlan(id));
        yield* Testkit.editPlan(planDocId, planWith(planDocId, edit));
        if (resubmit) yield* service.submitForDiscussion(cardId);
        const live = (yield* Testkit.liveSha256Of(planDocId)) ?? "";
        assert.notEqual(live, shown);

        const stale = yield* service.accept({ cardId, sha256: shown }).pipe(Effect.flip);
        assert.equal(stale.code, "plan_changed");
        assert.equal((yield* service.get(cardId))?.state, "discussion");

        if (resubmit) {
          const accepted = yield* service.accept({ cardId, sha256: live });
          assert.equal(accepted.acceptedSha256, live);
        }
      }),
    ),
  options(25),
);

it.effect.prop(
  "records one discussion version per distinct document across repeated submits",
  { drafts: Arbitrary.array(stepRows, { minLength: 1, maxLength: 4 }) },
  ({ drafts }) =>
    Testkit.withPlanning(
      Effect.gen(function* () {
        const { service, planDocId } = yield* submitted((id) => planWith(id, drafts[0] ?? []));
        const shas = new Set([(yield* Testkit.liveSha256Of(planDocId)) ?? ""]);
        yield* service.submitForDiscussion(cardId);
        for (const draft of drafts.slice(1)) {
          yield* Testkit.editPlan(planDocId, planWith(planDocId, draft));
          shas.add((yield* Testkit.liveSha256Of(planDocId)) ?? "");
          yield* service.submitForDiscussion(cardId);
          yield* service.submitForDiscussion(cardId);
        }
        assert.equal(yield* discussionVersions, shas.size);
      }),
    ),
  options(25),
);
