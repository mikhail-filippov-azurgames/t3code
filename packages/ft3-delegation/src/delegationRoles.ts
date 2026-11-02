// @effect-diagnostics nodeBuiltinImport:off - role instruction files live on disk; sync reads keep role validation pure.
import type { OrchestrationV2DelegatedTaskRole } from "@t3tools/contracts";
import { setNativeSubagentGuidance } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const ROLES_DIR_ENV = "T3CODE_FT3_ROLES_DIR";

/** Role ids the fork accepts; each one needs `<rolesDir>/<role>.md`. */
export const DELEGATED_ROLE_IDS = [
  "lead",
  "architect",
  "architect-boundaries",
  "architect-data",
  "architect-failure",
  "architect-product",
  "planner",
  "implementation",
  "test",
  "research",
  "general",
  "review-common",
  "review-contracts",
  "review-failure-paths",
  "review-architecture",
] as const;
export type DelegatedRoleId = (typeof DELEGATED_ROLE_IDS)[number];

/**
 * Upstream role values whose instruction file has a different name. `architecture`
 * stays in the upstream enum for existing callers, but the fork's consultant role
 * file is `architect.md`.
 */
export const ROLE_FILE_ALIASES: Readonly<Record<string, string>> = { architecture: "architect" };

/** The `<role>.md` basename a delegated role resolves to. */
export const roleFileName = (role: string): string => ROLE_FILE_ALIASES[role] ?? role;

/** The role ids the upstream schema already accepted before roles were configurable. */
export const UPSTREAM_ROLE_IDS = [
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
  "architecture",
] as const;

/** The role a delegated child gets when the caller names none and roles are configured. */
export const DEFAULT_DELEGATED_ROLE = "general" as const;

const isDirectory = (path: string): boolean =>
  NodeFS.statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

export const rolesDirPath = (configured: string): string => forwardSlashes(configured.trim());

// Server setting: the directory that holds one Markdown instruction file per role.
export const rolesDir: Effect.Effect<string, never> = Config.String(ROLES_DIR_ENV).pipe(
  Config.withDefault(""),
  Effect.orElseSucceed(() => ""),
  Effect.map(rolesDirPath),
  Effect.filterOrElse(
    (dir: string) => dir === "" || isDirectory(dir),
    (dir) =>
      Effect.die(
        new Error(
          `${ROLES_DIR_ENV} is ${dir}, which is not an existing directory. Point it at the directory that holds one Markdown instruction file per role, or leave it empty to turn roles off.`,
        ),
      ),
  ),
);

export const roleInstructionLine = (role: string, dir: string): string =>
  `Your role is ${role}. Before any work, read the whole file ${rolesDirPath(dir)}/${role}.md and follow it.`;

/** Role ids that have a file in the configured directory, for error messages and discovery. */
export function availableRoles(dir: string): ReadonlyArray<string> {
  const configured = rolesDirPath(dir);
  if (configured === "") return [];
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(configured);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length))
    .sort();
}

const hasRoleFile = (dir: string, role: string): boolean =>
  NodeFS.statSync(NodePath.join(rolesDirPath(dir), `${roleFileName(role)}.md`), {
    throwIfNoEntry: false,
  })?.isFile() === true;

/**
 * The role the child runs as. Roles off keeps the upstream behaviour: the
 * caller's role or none. Roles on defaults to `general` and needs an
 * instruction file, so a typo cannot silently run a child without guidance.
 */
export type DelegatedRoleAssignment =
  | { readonly _tag: "off"; readonly role: OrchestrationV2DelegatedTaskRole | undefined }
  | { readonly _tag: "assigned"; readonly role: OrchestrationV2DelegatedTaskRole }
  | { readonly _tag: "rejected"; readonly message: string };

const unavailableRole = (role: string, dir: string): DelegatedRoleAssignment => {
  const available = availableRoles(dir);
  const file = roleFileName(role);
  return {
    _tag: "rejected",
    message:
      available.length === 0
        ? `Role "${role}" has no ${rolesDirPath(dir)}/${file}.md and ${ROLES_DIR_ENV} holds no role Markdown files. Add <role>.md files to that directory or unset ${ROLES_DIR_ENV}.`
        : `Role "${role}" has no ${rolesDirPath(dir)}/${file}.md. Available roles: ${available.join(", ")}.`,
  };
};

export function delegatedRoleAssignment(
  role: OrchestrationV2DelegatedTaskRole | undefined,
  dir: string,
): DelegatedRoleAssignment {
  const configured = rolesDirPath(dir);
  if (configured === "") {
    if (role === undefined || UPSTREAM_ROLE_IDS.some((candidate) => candidate === role)) {
      return { _tag: "off", role };
    }
    return {
      _tag: "rejected",
      message: `Role "${role}" needs ${ROLES_DIR_ENV}. Without it the accepted roles are: ${UPSTREAM_ROLE_IDS.join(", ")}.`,
    };
  }
  const resolved = role ?? DEFAULT_DELEGATED_ROLE;
  return hasRoleFile(configured, resolved)
    ? { _tag: "assigned", role: resolved }
    : unavailableRole(resolved, configured);
}

/**
 * The child's first prompt: the role instruction when roles are configured,
 * else the upstream prompt untouched. The role line supersedes upstream's
 * `Act as the <role> sub-agent` prefix, so it is not repeated.
 */
export function delegatedTaskPrompt(input: {
  readonly role: OrchestrationV2DelegatedTaskRole | undefined;
  readonly rolesDir: string;
  readonly task: string;
  readonly upstreamPrompt: string;
}): string {
  const configured = rolesDirPath(input.rolesDir);
  if (configured === "") return input.upstreamPrompt;
  const role = roleFileName(input.role ?? DEFAULT_DELEGATED_ROLE);
  return `${roleInstructionLine(role, configured)}\n\n${input.task}`;
}

/** Server startup: fail on an unusable roles directory and drop native-subagent guidance when on. */
export const startupRoleConfiguration: Effect.Effect<void, never> = Effect.gen(function* () {
  const configured = yield* rolesDir;
  setNativeSubagentGuidance(configured === "");
});

/** The role line a Coordinator brief starts with; empty while roles are off. */
export function coordinatorBriefRoleLine(dir: string): string {
  const configured = rolesDirPath(dir);
  return configured === "" ? "" : roleInstructionLine("lead", configured);
}
