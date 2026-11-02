import type { ScopedThreadRef } from "@t3tools/contracts";
import type { VcsResolvedCommitMention } from "@t3tools/ft3-vcs/contracts";

import type { DiffPanelSelection } from "~/diffPanelStore";

/** The graph highlights the commit the diff panel currently shows. */
export function selectedCommitId(selection: DiffPanelSelection | undefined): string | null {
  return selection?.kind === "commit" ? selection.sha : null;
}

/**
 * Opens the commit in the upstream diff panel. A closed panel would reset the
 * selection to the branch diff on open, so the selection asks to be kept.
 */
export function selectCommitFromGraph(input: {
  readonly threadRef: ScopedThreadRef;
  readonly commitId: string;
  readonly diffOpen: boolean;
  readonly selectCommit: (ref: ScopedThreadRef, sha: string, keepOnOpen?: boolean) => void;
  readonly openDiffPanel: (ref: ScopedThreadRef) => void;
}) {
  input.selectCommit(input.threadRef, input.commitId, !input.diffOpen);
  input.openDiffPanel(input.threadRef);
}

/** A mentioned commit may live in a repository nested under the thread cwd. */
export function findResolvedCommit(input: {
  readonly commitId: string;
  readonly commits: ReadonlyArray<VcsResolvedCommitMention>;
}): VcsResolvedCommitMention | null {
  const commitId = input.commitId.toLowerCase();
  return input.commits.find((mention) => mention.commit.startsWith(commitId)) ?? null;
}
