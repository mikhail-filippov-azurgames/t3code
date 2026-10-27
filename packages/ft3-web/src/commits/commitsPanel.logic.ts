import type { ScopedThreadRef } from "@t3tools/contracts";

import type { DiffPanelSelection } from "~/diffPanelStore";

/** The graph highlights the commit the diff panel currently shows. */
export function selectedCommitId(selection: DiffPanelSelection | undefined): string | null {
  return selection?.kind === "commit" ? selection.commitId : null;
}

/**
 * Opens the commit in V2's diff panel. The selection is what the panel reads,
 * so the graph stays highlighted when the user returns to it.
 */
export function selectCommitFromGraph(input: {
  readonly threadRef: ScopedThreadRef;
  readonly commitId: string;
  readonly selectCommit: (ref: ScopedThreadRef, commitId: string) => void;
  readonly openDiffPanel: (ref: ScopedThreadRef) => void;
}) {
  input.selectCommit(input.threadRef, input.commitId);
  input.openDiffPanel(input.threadRef);
}
