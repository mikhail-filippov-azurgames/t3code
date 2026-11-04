import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PolicyDocumentKey, PolicyDocumentSource } from "./contracts.ts";
import {
  isProtectedDocument,
  protectedDocumentIdentities,
  resolveProtectedIdentities,
} from "./policyProtection.ts";

const builtin: Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>> = {
  routingPolicy: { kind: "builtin" },
  roles: { kind: "builtin" },
  leadSkills: { kind: "builtin" },
};

describe("policy document protection identities", () => {
  it("protects nothing when every document is built in", () => {
    const identities = protectedDocumentIdentities(builtin, "/store");
    expect(identities.stableIds.size).toBe(0);
    expect(identities.relPaths.size).toBe(0);
    expect(identities.prefixes.size).toBe(0);
    expect(
      isProtectedDocument(identities, { stableId: "plan-1", relPath: "corvis/plans/a.md" }),
    ).toBe(false);
  });

  it("protects a routing policy addressed by id", () => {
    const identities = protectedDocumentIdentities(
      {
        ...builtin,
        routingPolicy: { kind: "doc", address: { kind: "id", stableId: "policy-1" } },
      },
      "/store",
    );
    expect(identities.stableIds.has("policy-1")).toBe(true);
    expect(identities.prefixes.size).toBe(0);
    expect(
      isProtectedDocument(identities, { stableId: "policy-1", relPath: "policies/moved.md" }),
    ).toBe(true);
    expect(
      isProtectedDocument(identities, { stableId: "other", relPath: "policies/moved.md" }),
    ).toBe(false);
  });

  it("protects a routing policy addressed by path, without a folder prefix", () => {
    const identities = protectedDocumentIdentities(
      {
        ...builtin,
        routingPolicy: { kind: "doc", address: { kind: "path", relPath: "policies/routing.md" } },
      },
      "/store",
    );
    expect(identities.relPaths.has("policies/routing.md")).toBe(true);
    expect(identities.prefixes.size).toBe(0);
    expect(isProtectedDocument(identities, { stableId: "x", relPath: "policies/routing.md" })).toBe(
      true,
    );
    expect(isProtectedDocument(identities, { stableId: "x", relPath: "policies/sibling.md" })).toBe(
      false,
    );
  });

  it("protects a roles tree by manifest path and folder prefix", () => {
    const identities = protectedDocumentIdentities(
      {
        ...builtin,
        roles: { kind: "doc", address: { kind: "path", relPath: "policies/roles/roles.json" } },
      },
      "/store",
    );
    expect(identities.relPaths.has("policies/roles/roles.json")).toBe(true);
    expect(identities.prefixes.has("policies/roles/")).toBe(true);
    expect(
      isProtectedDocument(identities, { stableId: "a", relPath: "policies/roles/roles.json" }),
    ).toBe(true);
    expect(
      isProtectedDocument(identities, { stableId: "b", relPath: "policies/roles/architect.md" }),
    ).toBe(true);
    expect(
      isProtectedDocument(identities, { stableId: "c", relPath: "policies/lead-skills.json" }),
    ).toBe(false);
  });

  it("protects the whole store when a tree manifest sits at the store root", () => {
    const identities = protectedDocumentIdentities(
      {
        ...builtin,
        leadSkills: { kind: "doc", address: { kind: "path", relPath: "lead-skills.json" } },
      },
      "/store",
    );
    expect(identities.prefixes.has("")).toBe(true);
    expect(isProtectedDocument(identities, { stableId: "x", relPath: "anywhere/note.md" })).toBe(
      true,
    );
  });

  it("protects an in-store path source by its store path", () => {
    const root = "/store";
    const identities = protectedDocumentIdentities(
      {
        ...builtin,
        routingPolicy: { kind: "path", path: `${root}/contexts/policies/routing.md` },
        roles: { kind: "path", path: `${root}/contexts/policies/roles/roles.json` },
      },
      root,
    );
    expect(identities.relPaths.has("policies/routing.md")).toBe(true);
    expect(identities.relPaths.has("policies/roles/roles.json")).toBe(true);
    expect(identities.prefixes.has("policies/roles/")).toBe(true);
    expect(identities.prefixes.has("policies/")).toBe(false);
  });

  it.effect("resolves id-addressed tree folders and plan documents through lookups", () =>
    Effect.gen(function* () {
      const identities = yield* resolveProtectedIdentities(
        {
          ...builtin,
          roles: { kind: "doc", address: { kind: "id", stableId: "roles-manifest" } },
        },
        "/store",
        {
          manifestRelPathOf: (stableId) =>
            Effect.succeed(stableId === "roles-manifest" ? "policies/roles/roles.json" : null),
          planStableIds: Effect.succeed(["plan-9"]),
        },
      );
      expect(identities.stableIds.has("roles-manifest")).toBe(true);
      expect(identities.prefixes.has("policies/roles/")).toBe(true);
      expect(
        isProtectedDocument(identities, { stableId: "other", relPath: "policies/roles/lead.md" }),
      ).toBe(true);
      expect(
        isProtectedDocument(identities, { stableId: "plan-9", relPath: "corvis/plans/a.md" }),
      ).toBe(true);
      expect(isProtectedDocument(identities, { stableId: "free", relPath: "notes/free.md" })).toBe(
        false,
      );
    }),
  );

  it.effect("reads a missing manifest or plan table as no identity", () =>
    Effect.gen(function* () {
      const identities = yield* resolveProtectedIdentities(
        {
          ...builtin,
          roles: { kind: "doc", address: { kind: "id", stableId: "gone" } },
        },
        "/store",
        {
          manifestRelPathOf: () => Effect.succeed(null),
          planStableIds: Effect.succeed([]),
        },
      );
      expect(identities.prefixes.size).toBe(0);
      expect(
        isProtectedDocument(identities, { stableId: "x", relPath: "policies/roles/lead.md" }),
      ).toBe(false);
      // The manifest document itself stays protected by its stable id.
      expect(
        isProtectedDocument(identities, { stableId: "gone", relPath: "policies/roles/roles.json" }),
      ).toBe(true);
    }),
  );

  it("ignores a path source outside the store", () => {
    const identities = protectedDocumentIdentities(
      {
        ...builtin,
        routingPolicy: { kind: "path", path: "/elsewhere/routing.md" },
      },
      "/store",
    );
    expect(identities.relPaths.size).toBe(0);
    expect(isProtectedDocument(identities, { stableId: "x", relPath: "policies/routing.md" })).toBe(
      false,
    );
  });
});
