import { describe, expect, it } from "@effect/vitest";
import { ProjectSettingsOverrides } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BUILTIN_POLICY_DOCUMENT_ASSETS, builtinPolicyDocumentAsset } from "./contracts.ts";
import {
  DEFAULT_POLICY_SETTINGS,
  decodePolicySettings,
  decodeProjectFeatureTogglesOverrideValue,
  decodeProjectPolicyDocumentOverrideValue,
  PolicyDocumentsSettings,
  type PoliciesSettings,
  readPolicySettings,
  resolvePolicyDocumentSources,
  resolveRequestedFeatures,
} from "./settings.ts";

// The repository never carries real document ids; tests use the nil UUID.
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const ENVIRONMENT_ROUTING_PATH = "/srv/corvis/policies/routing-policy.md";
const PROJECT_ROUTING_PATH = "/srv/project-alpha/policies/routing-policy.md";

const decodeDocumentsSettings = Schema.decodeSync(PolicyDocumentsSettings);
const decodeProjectSettingsOverrides = Schema.decodeSync(ProjectSettingsOverrides);

describe("policy settings decode", () => {
  it("decodes an empty namespace into builtin templates and the toggle defaults", () => {
    const settings = decodeDocumentsSettings({});

    expect(settings).toEqual({
      routingPolicy: { kind: "builtin" },
      roles: { kind: "builtin" },
      leadSkills: { kind: "builtin" },
    });
    expect(DEFAULT_POLICY_SETTINGS.applyExternalEdits).toBe(false);
    expect(DEFAULT_POLICY_SETTINGS.features.documents).toBe(true);
    expect(DEFAULT_POLICY_SETTINGS.features.roles).toBe(true);
    expect(DEFAULT_POLICY_SETTINGS.features.board).toBe(true);
    expect(DEFAULT_POLICY_SETTINGS.features.mail).toBe(false);
    expect(DEFAULT_POLICY_SETTINGS.features.planning).toBe(false);
    expect(Object.keys(DEFAULT_POLICY_SETTINGS.features)).toHaveLength(15);
  });

  it("decodes the stored settings document and fills absent toggles", () => {
    const decoded = decodePolicySettings({
      documents: {
        routingPolicy: { kind: "path", path: ENVIRONMENT_ROUTING_PATH },
        roles: { kind: "doc", address: { kind: "id", stableId: NIL_ID } },
      },
      applyExternalEdits: true,
      features: { documents: false, mail: true },
    });

    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) return;
    expect(decoded.value.documents.routingPolicy).toEqual({
      kind: "path",
      path: ENVIRONMENT_ROUTING_PATH,
    });
    expect(decoded.value.documents.roles).toEqual({
      kind: "doc",
      address: { kind: "id", stableId: NIL_ID },
    });
    expect(decoded.value.documents.leadSkills).toEqual({ kind: "builtin" });
    expect(decoded.value.applyExternalEdits).toBe(true);
    expect(decoded.value.features.documents).toBe(false);
    expect(decoded.value.features.mail).toBe(true);
    expect(decoded.value.features.planning).toBe(false);
  });

  it("drops the retired architect toggle instead of failing the document", () => {
    const decoded = decodePolicySettings({
      features: { architect: true, planning: true },
    });

    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) return;
    expect(decoded.value.features.planning).toBe(true);
    expect(Object.hasOwn(decoded.value.features, "architect")).toBe(false);
  });

  it("rejects an empty path and an unknown source kind", () => {
    expect(
      Option.isNone(decodePolicySettings({ documents: { roles: { kind: "path", path: " " } } })),
    ).toBe(true);
    expect(Option.isNone(decodePolicySettings({ documents: { roles: { kind: "remote" } } }))).toBe(
      true,
    );
  });

  it("reads only the policies key of the ft3 namespace and falls back on corrupt values", () => {
    expect(readPolicySettings({ policies: { features: { mail: true } } }).features.mail).toBe(true);
    expect(readPolicySettings({ docs: { root: "/srv/corvis/documents" } })).toEqual(
      DEFAULT_POLICY_SETTINGS,
    );
    expect(readPolicySettings({ policies: "not-an-object" })).toEqual(DEFAULT_POLICY_SETTINGS);
    expect(readPolicySettings(undefined)).toEqual(DEFAULT_POLICY_SETTINGS);
  });

  it("maps every document key to a bundled package asset", () => {
    expect(builtinPolicyDocumentAsset("routingPolicy")).toBe(
      BUILTIN_POLICY_DOCUMENT_ASSETS.routingPolicy,
    );
    expect(new Set(Object.values(BUILTIN_POLICY_DOCUMENT_ASSETS)).size).toBe(3);
    for (const asset of Object.values(BUILTIN_POLICY_DOCUMENT_ASSETS)) {
      expect(asset.startsWith("assets/")).toBe(true);
    }
  });
});

describe("project policy document override", () => {
  const settings: PoliciesSettings = {
    documents: {
      routingPolicy: { kind: "path", path: ENVIRONMENT_ROUTING_PATH },
      roles: { kind: "builtin" },
      leadSkills: { kind: "builtin" },
    },
    applyExternalEdits: false,
    features: DEFAULT_POLICY_SETTINGS.features,
  };

  it("takes precedence over the environment source for one document only", () => {
    const override = Option.getOrThrow(
      decodeProjectPolicyDocumentOverrideValue({
        key: "routingPolicy",
        source: { kind: "path", path: PROJECT_ROUTING_PATH },
      }),
    );

    const sources = resolvePolicyDocumentSources(settings, override);

    expect(sources.routingPolicy).toEqual({ kind: "path", path: PROJECT_ROUTING_PATH });
    expect(sources.roles).toEqual({ kind: "builtin" });
    expect(sources.leadSkills).toEqual({ kind: "builtin" });
  });

  it("does not change another document's source", () => {
    const override = Option.getOrThrow(
      decodeProjectPolicyDocumentOverrideValue({
        key: "roles",
        source: { kind: "doc", address: { kind: "path", relPath: "projects/alpha/roles.json" } },
      }),
    );

    const sources = resolvePolicyDocumentSources(settings, override);

    expect(sources.routingPolicy).toEqual({
      kind: "path",
      path: ENVIRONMENT_ROUTING_PATH,
    });
    expect(sources.roles).toEqual({
      kind: "doc",
      address: { kind: "path", relPath: "projects/alpha/roles.json" },
    });
  });

  it("keeps the environment sources without an override", () => {
    expect(resolvePolicyDocumentSources(settings)).toEqual(settings.documents);
    expect(resolvePolicyDocumentSources(settings, null)).toEqual(settings.documents);
  });

  it("rejects an unknown document key", () => {
    expect(
      Option.isNone(
        decodeProjectPolicyDocumentOverrideValue({
          key: "architect",
          source: { kind: "builtin" },
        }),
      ),
    ).toBe(true);
  });

  it("is accepted by the upstream project-override seam without new scoping", () => {
    const decoded = decodeProjectSettingsOverrides({
      ft3PolicyDocuments: {
        key: "routingPolicy",
        source: { kind: "path", path: PROJECT_ROUTING_PATH },
      },
    });

    expect(decoded.ft3PolicyDocuments).toEqual({
      key: "routingPolicy",
      source: { kind: "path", path: PROJECT_ROUTING_PATH },
    });
  });
});

describe("project feature toggles override", () => {
  const settings: PoliciesSettings = {
    documents: {
      routingPolicy: { kind: "builtin" },
      roles: { kind: "builtin" },
      leadSkills: { kind: "builtin" },
    },
    applyExternalEdits: false,
    features: DEFAULT_POLICY_SETTINGS.features,
  };

  it("absent override inherits the environment defaults", () => {
    expect(Option.isNone(decodeProjectFeatureTogglesOverrideValue(undefined))).toBe(true);
    expect(resolveRequestedFeatures(settings)).toEqual(settings.features);
    expect(resolveRequestedFeatures(settings, null)).toEqual(settings.features);
  });

  it("partial override changes only the listed toggles, both directions", () => {
    const override = Option.getOrThrow(
      decodeProjectFeatureTogglesOverrideValue({ mail: true, planning: false }),
    );

    const requested = resolveRequestedFeatures(settings, override);

    expect(requested.mail).toBe(true);
    expect(requested.planning).toBe(false);
    expect(requested.board).toBe(settings.features.board);
    expect(Object.keys(override)).toEqual(["mail", "planning"]);
  });

  it("drops unknown toggle keys instead of failing the override", () => {
    const decoded = decodeProjectFeatureTogglesOverrideValue({ architect: true, mail: true });

    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) return;
    expect(decoded.value).toEqual({ mail: true });
  });

  it("drops the environment-only documents toggle like an unknown key", () => {
    const decoded = decodeProjectFeatureTogglesOverrideValue({ documents: false, mail: true });

    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) return;
    expect(decoded.value).toEqual({ mail: true });
  });

  it("corrupt override decodes to no override", () => {
    expect(Option.isNone(decodeProjectFeatureTogglesOverrideValue({ mail: "yes" }))).toBe(true);
    expect(Option.isNone(decodeProjectFeatureTogglesOverrideValue("not-an-object"))).toBe(true);

    const requested = resolveRequestedFeatures(
      settings,
      Option.getOrElse(decodeProjectFeatureTogglesOverrideValue({ mail: "yes" }), () => null),
    );
    expect(requested).toEqual(settings.features);
  });

  it("is accepted by the upstream project-override seam without new scoping", () => {
    const decoded = decodeProjectSettingsOverrides({
      ft3FeatureToggles: { mail: true, planning: false },
    });

    expect(decoded.ft3FeatureToggles).toEqual({ mail: true, planning: false });
  });
});
