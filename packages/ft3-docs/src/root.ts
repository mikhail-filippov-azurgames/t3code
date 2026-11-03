// @effect-diagnostics nodeBuiltinImport:off - the store root is a host path, not an environment program.
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

export const DocsSettings = Schema.Struct({
  root: DocsRootSetting.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
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
export function resolveDocsRoot(input: DocsRootInput): string {
  const configured = input.configuredRoot?.trim() ?? "";
  if (configured !== "") return NodePath.resolve(configured);
  const fromEnvironment = input.environment?.[DOCS_ROOT_ENV]?.trim();
  return fromEnvironment
    ? NodePath.resolve(fromEnvironment)
    : NodePath.join(input.stateDir, "documents");
}
