// @effect-diagnostics nodeBuiltinImport:off - the test asserts the path a setting resolves to.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  DEFAULT_DOCS_SETTINGS,
  DOCS_ROOT_ENV,
  decodeDocsSettingsValue,
  readDocsSettings,
  resolveDocsRoot,
} from "./root.ts";

const STATE_DIR = NodePath.join("home", "t3", "userdata");
const CONFIGURED_ROOT = NodePath.join("srv", "opencontext");

describe("docs root setting", () => {
  it("defaults to an empty store under the state directory", () => {
    expect(DEFAULT_DOCS_SETTINGS.root).toBeNull();
    expect(
      resolveDocsRoot({ stateDir: STATE_DIR, configuredRoot: DEFAULT_DOCS_SETTINGS.root }),
    ).toBe(NodePath.join(STATE_DIR, "documents"));
  });

  it("points at the configured store, as on a machine that already has one", () => {
    expect(resolveDocsRoot({ stateDir: STATE_DIR, configuredRoot: CONFIGURED_ROOT })).toBe(
      NodePath.resolve(CONFIGURED_ROOT),
    );
  });

  it("reads ft3.docs without touching other fork settings", () => {
    expect(readDocsSettings({ docs: { root: CONFIGURED_ROOT } }).root).toBe(CONFIGURED_ROOT);
    expect(readDocsSettings({ policies: { applyExternalEdits: true } })).toEqual(
      DEFAULT_DOCS_SETTINGS,
    );
    expect(readDocsSettings(undefined)).toEqual(DEFAULT_DOCS_SETTINGS);
  });

  it("rejects a blank or oversized root and falls back to the default", () => {
    expect(decodeDocsSettingsValue({ root: " " })).toMatchObject({ _tag: "None" });
    expect(decodeDocsSettingsValue({ root: "x".repeat(4097) })).toMatchObject({ _tag: "None" });
    expect(readDocsSettings({ docs: { root: "" } })).toEqual(DEFAULT_DOCS_SETTINGS);
  });

  it("keeps OPENCONTEXT_HOME as an explicit environment fallback", () => {
    expect(
      resolveDocsRoot({
        stateDir: STATE_DIR,
        configuredRoot: null,
        environment: { [DOCS_ROOT_ENV]: CONFIGURED_ROOT },
      }),
    ).toBe(NodePath.resolve(CONFIGURED_ROOT));
    expect(
      resolveDocsRoot({
        stateDir: STATE_DIR,
        configuredRoot: CONFIGURED_ROOT,
        environment: { [DOCS_ROOT_ENV]: NodePath.join("elsewhere") },
      }),
    ).toBe(NodePath.resolve(CONFIGURED_ROOT));
  });
});
