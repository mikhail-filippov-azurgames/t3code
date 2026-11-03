// @effect-diagnostics nodeBuiltinImport:off - the store root is a host path, not an environment program.
import * as NodePath from "node:path";

/** Environment override the local store's own tooling honours. */
export const DOCS_ROOT_ENV = "OPENCONTEXT_HOME";

export interface DocsRootInput {
  /** The T3 server state directory: `<T3 home>/userdata` for a standalone install. */
  readonly stateDir: string;
  /**
   * Environment that may carry `OPENCONTEXT_HOME`. Only the settings/env
   * migration passes it; the composition uses the state directory so a test
   * never opens the store a developer has on disk.
   */
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * The store root: `OPENCONTEXT_HOME` when the caller passes an environment that
 * sets it (this machine's store lives at `~/.opencontext`), else an empty store
 * inside the server state directory (design §6.1). The value is configuration;
 * no path is part of the repository.
 */
export function resolveDocsRoot(input: DocsRootInput): string {
  const configured = input.environment?.[DOCS_ROOT_ENV]?.trim();
  return configured ? NodePath.resolve(configured) : NodePath.join(input.stateDir, "documents");
}
