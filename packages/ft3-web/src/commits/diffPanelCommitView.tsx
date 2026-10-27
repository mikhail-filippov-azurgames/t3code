import type { ReactNode } from "react";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { DiffPanelShell, type DiffPanelMode } from "~/components/DiffPanelShell";
import type { DiffPanelSelection } from "~/diffPanelStore";
import { CommitDiffPanel } from "./CommitDiffPanel.tsx";

/**
 * Renders a commit picked in the graph inside V2's diff panel shell. Returning
 * null leaves every other selection to the upstream panel.
 */
export function diffPanelCommitView(input: {
  readonly mode: DiffPanelMode;
  readonly selection: DiffPanelSelection;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | null;
}): ReactNode | null {
  const { mode, selection, threadRef, cwd } = input;
  if (selection.kind !== "commit") return null;
  return (
    <DiffPanelShell
      mode={mode}
      header={
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <span className="truncate">Commit {selection.commitId.slice(0, 7)}</span>
        </div>
      }
    >
      {threadRef ? (
        <CommitDiffPanel
          environmentId={threadRef.environmentId}
          cwd={cwd}
          commitId={selection.commitId}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect a commit.
        </div>
      )}
    </DiffPanelShell>
  );
}
