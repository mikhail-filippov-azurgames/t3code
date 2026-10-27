import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { useProject, useThreadShell } from "~/state/entities";
import { useRightPanelStore } from "~/rightPanelStore";

import { CommitsGraph } from "./CommitsGraph.tsx";
import { selectCommitFromGraph, selectedCommitId } from "./commitsPanel.logic.ts";
import type { Ft3PanelProps } from "../panels.tsx";

export default function CommitsPanel({ threadRef, visible }: Ft3PanelProps) {
  const shell = useThreadShell(threadRef);
  const projectRef = useMemo<ScopedProjectRef | null>(
    () =>
      shell === null
        ? null
        : { environmentId: threadRef.environmentId, projectId: shell.projectId },
    [shell, threadRef.environmentId],
  );
  const project = useProject(projectRef);
  const cwd = shell?.worktreePath ?? project?.workspaceRoot ?? null;
  const selection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const focusCommitId = selectedCommitId(selection);
  const onCommitSelect = useCallback(
    (commitId: string) => {
      selectCommitFromGraph({
        threadRef,
        commitId,
        selectCommit: useDiffPanelStore.getState().selectCommit,
        openDiffPanel: (ref) => useRightPanelStore.getState().open(ref, "diff"),
      });
    },
    [threadRef],
  );

  if (!visible || cwd === null) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Commit graph">
      <CommitsGraph
        key={`${threadRef.environmentId}|${cwd}`}
        environmentId={threadRef.environmentId}
        cwd={cwd}
        className="min-h-0 flex-1"
        focusCommitId={focusCommitId}
        onCommitSelect={onCommitSelect}
      />
    </div>
  );
}
