// @effect-diagnostics nodeBuiltinImport:off - the roles directory setting is validated on disk; a sync check keeps startup pure.
import { documentsBriefLine } from "@t3tools/ft3-docs/brief";
import { setNativeSubagentGuidance } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";

export const ROLES_DIR_ENV = "T3CODE_FT3_ROLES_DIR";

/** Role ids the fork accepts; each one needs an entry in the applied roles document. */
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

const isDirectory = (path: string): boolean =>
  NodeFS.statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

export const rolesDirPath = (configured: string): string => forwardSlashes(configured.trim());

// Server setting: the directory that holds the Markdown instruction files of the roles tree.
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

/**
 * The child's first prompt: the applied role instruction, else the upstream
 * prompt. The documents brief block follows the role line while documents are
 * on.
 */
export function delegatedTaskPrompt(input: {
  readonly roleLine: string;
  readonly task: string;
  readonly upstreamPrompt: string;
}): string {
  const documents = documentsBriefLine();
  const withDocuments = (prompt: string) =>
    documents === "" ? prompt : `${documents}\n\n${prompt}`;
  const roleLine = input.roleLine.trim();
  return roleLine === ""
    ? withDocuments(input.upstreamPrompt)
    : `${roleLine}\n\n${withDocuments(input.task)}`;
}

/** Server startup: fail on an unusable roles directory and drop native-subagent guidance when on. */
export const startupRoleConfiguration: Effect.Effect<void, never> = Effect.gen(function* () {
  const configured = yield* rolesDir;
  setNativeSubagentGuidance(configured === "");
});
