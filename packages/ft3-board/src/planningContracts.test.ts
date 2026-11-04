import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PlanCitation } from "./planningContracts.ts";

const decodeCitation = Schema.decodeSync(PlanCitation);

const citation = {
  planDocId: "11111111-1111-4111-8111-111111111111",
  planStep: "P2",
  planSha256: "a".repeat(64),
  quote: "Store the plan in the docs store.",
};

describe("PlanCitation", () => {
  it("decodes a citation with a short quote", () => {
    assert.deepStrictEqual(decodeCitation(citation), citation);
  });

  it("rejects a quote longer than 200 characters", () => {
    assert.deepStrictEqual(
      decodeCitation({ ...citation, quote: "x".repeat(200) }).quote,
      "x".repeat(200),
    );
    assert.throws(() => decodeCitation({ ...citation, quote: "x".repeat(201) }));
  });

  it("rejects a digest that is not lowercase hex", () => {
    assert.throws(() => decodeCitation({ ...citation, planSha256: "z".repeat(64) }));
    assert.throws(() => decodeCitation({ ...citation, planSha256: "abc" }));
  });

  it("rejects a blank step", () => {
    assert.throws(() => decodeCitation({ ...citation, planStep: "  " }));
  });
});
