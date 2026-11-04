// @effect-diagnostics nodeBuiltinImport:off - the store root is a host path, not an environment program.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Environment override the local store's own tooling honours. */
export const DOCS_ROOT_ENV = "OPENCONTEXT_HOME";

/** Namespace of the document store settings inside `ServerSettings.ft3`. */
export const DOCS_SETTINGS_NAMESPACE = "docs";

export const DOCS_ROOT_MAX_LENGTH = 4096;

const isNonBlankPath = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a non-empty server path",
});

/** Absolute server path of the store root; the design stores it only in settings, never in the repo. */
export const DocsRootSetting = Schema.NullOr(
  Schema.String.check(isNonBlankPath, Schema.isMaxLength(DOCS_ROOT_MAX_LENGTH)),
);

export const DOCS_PLANS_FOLDER_MAX_LENGTH = 1024;

/** Folder new plan documents are created in, relative to `contexts/` (design §6.1). */
export const DEFAULT_PLANS_FOLDER = "corvis/plans";

/**
 * Canonicalizes a store-relative folder: `/` separators, no absolute roots,
 * no `.` or `..` segments, no empty segments. Returns null for anything else.
 */
export function normalizePlansFolder(value: string): string | null {
  const candidate = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (candidate.length === 0) return null;
  if (candidate.startsWith("/") || candidate.startsWith("~")) return null;
  if (/^[A-Za-z]:/.test(candidate)) return null;
  if (candidate.includes("://")) return null;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

/**
 * A store-relative folder path in canonical form; blank, absolute, escaping
 * and non-canonical values (trailing slashes, backslashes, padding) fall back
 * to the default folder with the rest of the docs settings.
 */
export const DocsPlansFolderSetting = Schema.String.check(
  Schema.makeFilter((value: string) => normalizePlansFolder(value) === value, {
    expected: "a store-relative folder path",
  }),
  Schema.isMaxLength(DOCS_PLANS_FOLDER_MAX_LENGTH),
);

export const DocsSettings = Schema.Struct({
  root: DocsRootSetting.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  plansFolder: DocsPlansFolderSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PLANS_FOLDER)),
  ),
});
export type DocsSettings = typeof DocsSettings.Type;

export const DEFAULT_DOCS_SETTINGS: DocsSettings = Schema.decodeSync(DocsSettings)({});

const decodeDocsSettings = Schema.decodeUnknownOption(DocsSettings);

/** Strict decode of `ft3.docs`; a corrupt value falls back to the default root. */
export function decodeDocsSettingsValue(raw: unknown): Option.Option<DocsSettings> {
  return decodeDocsSettings(raw);
}

export function readDocsSettings(
  ft3Namespace: Readonly<Record<string, unknown>> | undefined,
): DocsSettings {
  const raw = ft3Namespace?.[DOCS_SETTINGS_NAMESPACE];
  return Option.getOrElse(decodeDocsSettings(raw), () => DEFAULT_DOCS_SETTINGS);
}

export interface DocsRootInput {
  /** The T3 server state directory: `<T3 home>/userdata` for a standalone install. */
  readonly stateDir: string;
  /** `ft3.docs.root`; null means the empty store inside the state directory. */
  readonly configuredRoot?: string | null;
  /**
   * Environment that may carry `OPENCONTEXT_HOME`. Only the settings/env
   * migration passes it; the composition uses the state directory so a test
   * never opens the store a developer has on disk.
   */
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * The store root: the configured `ft3.docs.root`, else `OPENCONTEXT_HOME` when
 * the caller passes an environment that sets it, else an empty store inside the
 * server state directory (design §6.1). The value is configuration; no path is
 * part of the repository.
 */
/** A leading `~` addresses the server user's home directory; `~other` never does. */
const expandHome = (root: string): string =>
  root === "~" || root.startsWith("~/") || root.startsWith("~\\")
    ? NodePath.join(NodeOS.homedir(), root.slice(2))
    : root;

export function resolveDocsRoot(input: DocsRootInput): string {
  const configured = input.configuredRoot?.trim() ?? "";
  if (configured !== "") return NodePath.resolve(expandHome(configured));
  const fromEnvironment = input.environment?.[DOCS_ROOT_ENV]?.trim();
  return fromEnvironment
    ? NodePath.resolve(expandHome(fromEnvironment))
    : NodePath.join(input.stateDir, "documents");
}
