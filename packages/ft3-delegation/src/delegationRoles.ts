import { documentsBriefLine } from "@t3tools/ft3-docs/brief";
import { setNativeSubagentGuidance } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";

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

/** Native-subagent guidance steps aside for `delegate_task` while the applied roles are configured. */
export const applyNativeSubagentGuidance = (rolesConfigured: boolean): Effect.Effect<void> =>
  Effect.sync(() => setNativeSubagentGuidance(!rolesConfigured));
