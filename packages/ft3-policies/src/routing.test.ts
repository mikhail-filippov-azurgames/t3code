import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PolicyChangeTracker } from "./policyChangeTracker.ts";
import type { LoadedRoutingPolicyDocument } from "./policyDocumentLoader.ts";
import {
  NormalServicePolicy,
  PolicyUsageRecorder,
  RoutingPolicyService,
  inMemoryPolicyUsageRecorder,
  normalServiceOptions,
  normalServicePolicyLayer,
  resolveRoutingCandidates,
  routingPolicyServiceLayer,
} from "./routing.ts";
import { type RoutingPolicy, parseRoutingPolicy } from "./routingPolicy.ts";

const CELL_HEADER = ["| Role | low | medium | high | very-high |", "|---|---|---|---|---|"];

const ALIAS_HEADER = [
  "| Alias | model | low | medium | high | very-high |",
  "|---|---|---|---|---|---|",
];

const DOCUMENT = [
  "---",
  "revision: 12",
  "---",
  "",
  ...CELL_HEADER,
  "| `architect` | A1 | A1 | A1 | A1 |",
  "| `implementation` | I1 → I2 | I2 → I1 | I1 → IH → I2 | IH → I1 |",
  "| `review-*` | R1 | R1 | R1 | R1 |",
  "| `test` | I1 | I1 | I1 | I1 |",
  "| `research` | R1 | R1 | R1 | R1 |",
  "| `general` | R1 | R1 | R1 | R1 |",
  "| `planner` | P@low → S@low | P@low → S@low | P@low → S@low | P@low → S@low |",
  "",
  "### Alpha (`alpha / acp`)",
  ...ALIAS_HEADER,
  "| A1 | `alpha-one` | `effort=low` | `effort=medium` | `effort=high` | `effort=high` |",
  "| I1 | `alpha-two` | `effort=low` | `effort=medium` | `effort=high` | `effort=high` |",
  "| I2 | `alpha-three` | `effort=low` | `effort=medium` | `effort=high` | `effort=high` |",
  "",
  "### Beta (`beta / codex`)",
  ...ALIAS_HEADER,
  "| IH | `beta-fast-highspeed` | `reasoningEffort=high` | `reasoningEffort=high` | `reasoningEffort=high` | `reasoningEffort=high` |",
  "| P | `beta-pro` | `serviceTier=priority, reasoningEffort=low` | `reasoningEffort=low` | `reasoningEffort=high` | `reasoningEffort=high` |",
  "",
  "### Gamma (`gamma / claudeAgent`)",
  ...ALIAS_HEADER,
  "| S | `gamma-sonnet` | `fastMode=true, effort=low` | `effort=medium` | `effort=high` | `effort=high` |",
  "| R1 | `gamma-one` | `variant=low` | `variant=medium` | `variant=high` | `variant=high` |",
  "",
].join("\n");

const policy = (): RoutingPolicy => {
  const parsed = parseRoutingPolicy(DOCUMENT);
  if (parsed.policy === null) throw new Error("the test document must parse");
  return parsed.policy;
};

const loaded = (document: RoutingPolicy | null): LoadedRoutingPolicyDocument => ({
  key: "routingPolicy",
  source: { kind: "builtin" },
  sha256: "sha-routing",
  revision: 12,
  configured: document !== null,
  valid: document !== null,
  issues: [],
  requirements: { routingPolicy: document !== null, requestedRoles: document !== null },
  files: [],
  document,
});

const trackerLayer = (document: LoadedRoutingPolicyDocument | null) =>
  Layer.succeed(PolicyChangeTracker, {
    refresh: () => Effect.die("the tracker is not refreshed in routing tests"),
    snapshot: () => Effect.die("the tracker is not snapshotted in routing tests"),
    applied: (key) => Effect.succeed(key === "routingPolicy" ? document : null),
    pendingChange: () => Effect.die("the tracker has no pending change in routing tests"),
    live: () => Effect.die("the tracker has no live document in routing tests"),
  });

const chain = (
  role: "implementation" | "planner",
  level: "low" | "medium" | "high" | "very-high",
) => resolveRoutingCandidates(policy(), { role, level });

describe("routing candidate chain", () => {
  it("uses the cell of the task level and the alias options of that level", () => {
    const resolved = chain("implementation", "medium");

    assert.deepStrictEqual(
      resolved.candidates.map((candidate) => candidate.alias),
      ["I2", "I1"],
    );
    assert.deepStrictEqual(resolved.candidates[0]?.options, [{ id: "effort", value: "medium" }]);
    assert.equal(resolved.candidates[0]?.level, "medium");
    assert.deepStrictEqual(resolved.skipped, []);
  });

  it("keeps alias@level pinned to its level whatever the task level is", () => {
    for (const level of ["low", "medium", "high", "very-high"] as const) {
      const resolved = chain("planner", level);
      assert.deepStrictEqual(
        resolved.candidates.map((candidate) => [candidate.alias, candidate.level]),
        [
          ["P", "low"],
          ["S", "low"],
        ],
      );
    }
    assert.deepStrictEqual(chain("planner", "very-high").candidates[1]?.options, [
      { id: "effort", value: "low" },
      { id: "fastMode", value: false },
    ]);
  });

  it("skips an accelerated model id and keeps the fallback order", () => {
    const resolved = chain("implementation", "high");

    assert.deepStrictEqual(
      resolved.candidates.map((candidate) => candidate.alias),
      ["I1", "I2"],
    );
    assert.deepStrictEqual(resolved.skipped, [
      { alias: "IH", model: "beta-fast-highspeed", reason: "accelerated_model" },
    ]);
  });

  it("reports an unknown alias instead of dropping it silently", () => {
    const broken = policy();
    const resolved = resolveRoutingCandidates(
      {
        ...broken,
        roles: {
          ...broken.roles,
          test: { ...broken.roles.test!, low: [{ alias: "ZZ", level: null }] },
        },
      },
      { role: "test", level: "low" },
    );

    assert.deepStrictEqual(resolved.candidates, []);
    assert.deepStrictEqual(resolved.skipped, [
      { alias: "ZZ", model: null, reason: "alias_unknown" },
    ]);
  });

  it("has no candidates when the policy has no row for the role", () => {
    const withoutPlannerRow = parseRoutingPolicy(
      DOCUMENT.split("\n")
        .filter((line) => !line.startsWith("| `planner`"))
        .join("\n"),
    );
    const withoutPlanner = withoutPlannerRow.policy;
    if (withoutPlanner === null) throw new Error("the policy without planner must still parse");

    assert.deepStrictEqual(
      resolveRoutingCandidates(withoutPlanner, { role: "planner", level: "low" }),
      {
        role: "planner",
        level: "low",
        candidates: [],
        skipped: [],
      },
    );
  });
});

describe("normal service policy", () => {
  it("forces the normal tier for Codex and Claude and drops it elsewhere", () => {
    const codex = normalServiceOptions("codex", {
      serviceTier: "priority",
      reasoningEffort: "high",
    });
    assert.deepStrictEqual(codex.options, [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "default" },
    ]);
    assert.equal(codex.accelerated, true);
    assert.deepStrictEqual(codex.removed, ["serviceTier"]);

    const claude = normalServiceOptions("claudeAgent", { fastMode: true, effort: "high" });
    assert.deepStrictEqual(claude.options, [
      { id: "effort", value: "high" },
      { id: "fastMode", value: false },
    ]);
    assert.equal(claude.accelerated, true);

    const other = normalServiceOptions("opencode", { priority: true, variant: "max" });
    assert.deepStrictEqual(other.options, [{ id: "variant", value: "max" }]);
    assert.deepStrictEqual(other.removed, ["priority"]);
  });

  it("does not flag an already normal tier as accelerated", () => {
    const codex = normalServiceOptions("codex", { serviceTier: "default" });
    assert.equal(codex.accelerated, false);
    assert.deepStrictEqual(codex.options, [{ id: "serviceTier", value: "default" }]);
  });

  it("turns an alias's accelerated tier into the normal one on the chain", () => {
    const resolved = chain("planner", "low");
    assert.deepStrictEqual(resolved.candidates[0]?.options, [
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "default" },
    ]);

    const sonnet = chain("planner", "high").candidates[1];
    assert.deepStrictEqual(sonnet?.options, [
      { id: "effort", value: "low" },
      { id: "fastMode", value: false },
    ]);
  });

  it.effect("applies the same rule to a model selection override", () => {
    return Effect.gen(function* () {
      const normal = yield* NormalServicePolicy;
      const result = normal.normalizeSelection({
        driverKind: "codex",
        instanceId: "beta",
        model: "beta-fast",
        options: [{ id: "serviceTier", value: "priority" }],
      });

      assert.deepStrictEqual(result.selection.options, [{ id: "serviceTier", value: "default" }]);
      assert.equal(result.accelerated, true);
      assert.equal(normal.isAcceleratedModel("something-highspeed"), true);
      assert.equal(normal.isAcceleratedModel("alpha-one"), false);
    }).pipe(Effect.provide(normalServicePolicyLayer));
  });
});

const serviceLayer = (
  document: LoadedRoutingPolicyDocument | null,
  recorder: ReturnType<typeof inMemoryPolicyUsageRecorder>,
) =>
  routingPolicyServiceLayer().pipe(
    Layer.provide(Layer.mergeAll(trackerLayer(document), normalServicePolicyLayer, recorder.layer)),
  );

describe("RoutingPolicyService", () => {
  it.effect("returns null while no routing policy version is applied", () => {
    const recorder = inMemoryPolicyUsageRecorder();
    return Effect.gen(function* () {
      const service = yield* RoutingPolicyService;
      assert.equal(yield* service.resolve({ role: "implementation", level: "low" }), null);
      assert.deepStrictEqual(recorder.entries(), []);
    }).pipe(Effect.provide(serviceLayer(null, recorder)));
  });

  it.effect("records the policy revision and the chosen candidate for a delegation", () => {
    const recorder = inMemoryPolicyUsageRecorder();
    return Effect.gen(function* () {
      const service = yield* RoutingPolicyService;
      const selection = yield* service.select({
        delegationId: "delegation-1",
        role: "implementation",
        level: "high",
      });

      assert.equal(selection?.policy.revision, 12);
      assert.equal(selection?.policy.sha256, "sha-routing");
      assert.equal(selection?.selected?.alias, "I1");
      assert.deepStrictEqual(recorder.entries(), [
        {
          delegationId: "delegation-1",
          role: "implementation",
          level: "high",
          policy: { revision: 12, sha256: "sha-routing" },
          candidate: {
            alias: "I1",
            provider: { instanceId: "alpha", driverKind: "acp" },
            model: "alpha-two",
            level: "high",
            options: [{ id: "effort", value: "high" }],
          },
          outcome: "selected",
        },
      ]);
    }).pipe(Effect.provide(serviceLayer(loaded(policy()), recorder)));
  });

  it.effect("records a no-candidate delegation with a null candidate", () => {
    const recorder = inMemoryPolicyUsageRecorder();
    const empty = policy();
    const noGeneral = {
      ...empty,
      roles: { ...empty.roles, general: { ...empty.roles.general!, low: [] } },
    };
    return Effect.gen(function* () {
      const service = yield* RoutingPolicyService;
      const selection = yield* service.select({
        delegationId: "delegation-2",
        role: "general",
        level: "low",
      });

      assert.equal(selection?.selected, null);
      assert.deepStrictEqual(recorder.entries(), [
        {
          delegationId: "delegation-2",
          role: "general",
          level: "low",
          policy: { revision: 12, sha256: "sha-routing" },
          candidate: null,
          outcome: "no_candidate",
        },
      ]);
    }).pipe(Effect.provide(serviceLayer(loaded(noGeneral), recorder)));
  });

  it.effect("skips a model the live catalog does not offer and falls through", () => {
    const recorder = inMemoryPolicyUsageRecorder();
    return Effect.gen(function* () {
      const service = yield* RoutingPolicyService;
      const resolution = yield* service.resolve({ role: "implementation", level: "medium" });

      assert.deepStrictEqual(
        resolution?.candidates.map((candidate) => candidate.alias),
        ["I2"],
      );
      assert.deepStrictEqual(resolution?.skipped, [
        { alias: "I1", model: "alpha-two", reason: "unavailable" },
      ]);
    }).pipe(
      Effect.provide(
        routingPolicyServiceLayer({
          catalog: {
            available: (input) => Effect.succeed(input.model !== "alpha-two"),
          },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              trackerLayer(loaded(policy())),
              normalServicePolicyLayer,
              recorder.layer,
            ),
          ),
        ),
      ),
    );
  });

  it.effect("uses the injected recorder port", () => {
    const recorded: string[] = [];
    const layer = routingPolicyServiceLayer().pipe(
      Layer.provide(
        Layer.mergeAll(
          trackerLayer(loaded(policy())),
          normalServicePolicyLayer,
          Layer.succeed(PolicyUsageRecorder, {
            record: (entry) =>
              Effect.sync(() => {
                recorded.push(`${entry.delegationId}:${entry.candidate?.alias ?? "none"}`);
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RoutingPolicyService;
      yield* service.select({ delegationId: "delegation-3", role: "implementation", level: "low" });
      assert.deepStrictEqual(recorded, ["delegation-3:I1"]);
    }).pipe(Effect.provide(layer));
  });
});
