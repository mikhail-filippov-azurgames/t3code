import { describe, expect, it } from "@effect/vitest";

import {
  FEATURE_IDS,
  FEATURE_REGISTRY,
  type FeatureId,
  type PolicyRequirementId,
  resolveFeatureStates,
} from "./contracts.ts";

const requested = (...enabled: readonly FeatureId[]) => {
  const toggles: Partial<Record<FeatureId, boolean>> = {};
  for (const id of FEATURE_IDS) toggles[id] = enabled.includes(id);
  return toggles;
};

const requirements = (invalid: readonly PolicyRequirementId[]) => {
  const validity: Partial<Record<PolicyRequirementId, boolean>> = {};
  for (const requirement of invalid) validity[requirement] = false;
  return validity;
};

describe("feature registry", () => {
  it("lists the design's features without the retired architect toggle", () => {
    expect(FEATURE_IDS).toEqual([
      "documents",
      "roles",
      "board",
      "mail",
      "planning",
      "delegation",
      "orchestration",
      "boardAutomation",
      "sidebarForest",
      "chatExtensions",
      "vcs",
      "pi",
      "kimi",
      "usage",
      "files",
    ]);
    expect((FEATURE_IDS as readonly string[]).includes("architect")).toBe(false);
    expect(Object.keys(FEATURE_REGISTRY)).not.toContain("architect");
  });

  it("declares the dependency graph from the design", () => {
    expect(FEATURE_REGISTRY.documents.dependencies).toEqual([]);
    expect(FEATURE_REGISTRY.roles.dependencies).toEqual([]);
    expect(FEATURE_REGISTRY.board.dependencies).toEqual(["roles"]);
    expect(FEATURE_REGISTRY.mail.dependencies).toEqual(["board", "delegation"]);
    expect(FEATURE_REGISTRY.planning.dependencies).toEqual(["mail", "documents"]);
  });

  it("only references known features and has no cycle", () => {
    const visiting = new Set<FeatureId>();
    const done = new Set<FeatureId>();

    const visit = (id: FeatureId) => {
      if (done.has(id)) return;
      expect(visiting.has(id)).toBe(false);
      visiting.add(id);
      for (const dependency of FEATURE_REGISTRY[id].dependencies) {
        expect(FEATURE_IDS).toContain(dependency);
        visit(dependency);
      }
      visiting.delete(id);
      done.add(id);
    };

    for (const id of FEATURE_IDS) visit(id);
    expect(done.size).toBe(FEATURE_IDS.length);
  });
});

describe("resolveFeatureStates", () => {
  it("turns planning off when its mail dependency is requested off", () => {
    const states = resolveFeatureStates({
      requested: requested("documents", "planning"),
    });

    expect(states.planning.requestedEnabled).toBe(true);
    expect(states.planning.effectiveEnabled).toBe(false);
    expect(states.planning.offReason).toEqual({
      code: "feature_dependency_off",
      dependency: "mail",
    });
    expect(states.mail.effectiveEnabled).toBe(false);
    expect(states.documents.effectiveEnabled).toBe(true);
  });

  it("turns planning off when the documents dependency is off", () => {
    const states = resolveFeatureStates({
      requested: requested("roles", "board", "delegation", "mail", "planning"),
    });

    expect(states.mail.effectiveEnabled).toBe(true);
    expect(states.planning.effectiveEnabled).toBe(false);
    expect(states.planning.offReason).toEqual({
      code: "feature_dependency_off",
      dependency: "documents",
    });
  });

  it("propagates a disabled dependency transitively", () => {
    const states = resolveFeatureStates({
      requested: requested("documents", "board", "delegation", "mail", "planning"),
    });

    expect(states.board.effectiveEnabled).toBe(false);
    expect(states.board.offReason).toEqual({ code: "feature_dependency_off", dependency: "roles" });
    expect(states.mail.effectiveEnabled).toBe(false);
    expect(states.mail.offReason).toEqual({ code: "feature_dependency_off", dependency: "board" });
    expect(states.planning.effectiveEnabled).toBe(false);
    expect(states.planning.offReason).toEqual({
      code: "feature_dependency_off",
      dependency: "mail",
    });
  });

  it("keeps a requested feature on when every dependency and requirement holds", () => {
    const states = resolveFeatureStates({
      requested: requested(...FEATURE_IDS),
      requirements: {},
    });

    for (const id of FEATURE_IDS) {
      expect(states[id].effectiveEnabled).toBe(true);
      expect(states[id].offReason).toBeNull();
    }
  });

  it("turns a feature off when a required document or role is invalid", () => {
    const states = resolveFeatureStates({
      requested: requested("documents", "roles", "board", "delegation", "mail"),
      requirements: requirements(["routingPolicy"]),
    });

    expect(states.mail.requestedEnabled).toBe(true);
    expect(states.mail.effectiveEnabled).toBe(false);
    expect(states.mail.offReason).toEqual({
      code: "feature_document_off",
      requirement: "routingPolicy",
    });
    expect(states.board.effectiveEnabled).toBe(true);
  });

  it("reports a dependency failure before a requirement failure", () => {
    const states = resolveFeatureStates({
      requested: requested("documents", "roles", "board", "delegation", "mail", "planning"),
      requirements: requirements(["routingPolicy", "plannerRole"]),
    });

    expect(states.mail.effectiveEnabled).toBe(false);
    expect(states.mail.offReason).toEqual({
      code: "feature_document_off",
      requirement: "routingPolicy",
    });
    expect(states.planning.offReason).toEqual({
      code: "feature_dependency_off",
      dependency: "mail",
    });
  });

  it("reports no reason for a feature that was not requested", () => {
    const states = resolveFeatureStates({ requested: requested() });

    expect(states.mail.requestedEnabled).toBe(false);
    expect(states.mail.effectiveEnabled).toBe(false);
    expect(states.mail.offReason).toBeNull();
  });
});
