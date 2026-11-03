import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Service from "./service.ts";
import * as WriteRule from "./writeRule.ts";

const topLevel: Service.DocsCaller = { threadId: "thread:lead", parentThreadId: null };
const child: Service.DocsCaller = { threadId: "thread:child", parentThreadId: "thread:lead" };

const facts = (
  overrides: Partial<WriteRule.DocumentsWriteFacts> = {},
): WriteRule.DocumentsWriteFacts => ({
  role: null,
  planStableId: null,
  granted: false,
  ...overrides,
});

const factsLayer = (value: WriteRule.DocumentsWriteFacts) =>
  Layer.succeed(
    WriteRule.DocumentsWriteFactsPort,
    WriteRule.DocumentsWriteFactsPort.of({ factsOf: () => Effect.succeed(value) }),
  );

const decideWith = (layer: Layer.Layer<Service.DocumentsWriteAccess>, caller: Service.DocsCaller) =>
  Effect.gen(function* () {
    const access = yield* Service.DocumentsWriteAccess;
    return yield* access.decide(caller);
  }).pipe(Effect.provide(layer));

describe("resolveDocumentsWrite", () => {
  it("allows a thread without a parent, whatever its role", () => {
    for (const role of [null, "general", "planner", "architect", "implementation"]) {
      assert.deepStrictEqual(WriteRule.resolveDocumentsWrite(topLevel, facts({ role })), {
        _tag: "Allow",
        scope: "store",
        reason: "top_level_thread",
      });
    }
  });

  it("denies a call that is not attached to a thread", () => {
    assert.deepStrictEqual(
      WriteRule.resolveDocumentsWrite({ threadId: null, parentThreadId: null }, facts()),
      { _tag: "Deny", reason: "no_caller_thread" },
    );
  });

  it("lets a planner write only the plan document of its card", () => {
    assert.deepStrictEqual(
      WriteRule.resolveDocumentsWrite(child, facts({ role: "planner", planStableId: "plan-1" })),
      { _tag: "Allow", scope: "document", stableId: "plan-1", reason: "planner_plan" },
    );
  });

  it("treats a thread with a plan identity as the planner", () => {
    assert.deepStrictEqual(
      WriteRule.resolveDocumentsWrite(child, facts({ planStableId: "plan-1" })),
      { _tag: "Allow", scope: "document", stableId: "plan-1", reason: "planner_plan" },
    );
  });

  it("denies a planner that has no plan document identity yet", () => {
    assert.deepStrictEqual(WriteRule.resolveDocumentsWrite(child, facts({ role: "planner" })), {
      _tag: "Deny",
      reason: "planner_plan_unknown",
    });
  });

  it("lets a general child write only with the lead's grant", () => {
    assert.deepStrictEqual(
      WriteRule.resolveDocumentsWrite(child, facts({ role: "general", granted: true })),
      { _tag: "Allow", scope: "store", reason: "granted_general" },
    );
    assert.deepStrictEqual(WriteRule.resolveDocumentsWrite(child, facts({ role: "general" })), {
      _tag: "Deny",
      reason: "general_without_grant",
    });
  });

  it("keeps every other delegated child read-only, grant or not", () => {
    for (const role of [
      "architect",
      "architect-product",
      "review-common",
      "implementation",
      "test",
      "research",
      null,
      "unknown",
    ]) {
      for (const granted of [false, true]) {
        assert.deepStrictEqual(WriteRule.resolveDocumentsWrite(child, facts({ role, granted })), {
          _tag: "Deny",
          reason: "child_read_only",
        });
      }
    }
  });
});

describe("lineage write rule layer", () => {
  it.effect("reads role, plan identity and grant from the supplied port", () =>
    Effect.gen(function* () {
      const grantedGeneral = WriteRule.documentsWriteAccessLayer.pipe(
        Layer.provide(factsLayer(facts({ role: "general", granted: true }))),
      );
      assert.deepStrictEqual(yield* decideWith(grantedGeneral, child), {
        _tag: "Allow",
        scope: "store",
        reason: "granted_general",
      });

      const planner = WriteRule.documentsWriteAccessLayer.pipe(
        Layer.provide(factsLayer(facts({ role: "planner", planStableId: "plan-1" }))),
      );
      assert.deepStrictEqual(yield* decideWith(planner, child), {
        _tag: "Allow",
        scope: "document",
        stableId: "plan-1",
        reason: "planner_plan",
      });
    }),
  );

  it.effect("defaults to no role, no plan identity and no grant", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decideWith(WriteRule.lineageDocumentsWrite, topLevel), {
        _tag: "Allow",
        scope: "store",
        reason: "top_level_thread",
      });
      assert.deepStrictEqual(yield* decideWith(WriteRule.lineageDocumentsWrite, child), {
        _tag: "Deny",
        reason: "child_read_only",
      });
    }),
  );
});
