import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { prepareDiffSelectionForPanelOpen } from "./commitsPanel.logic.ts";

const threadRef = { environmentId: "environment-1", threadId: "thread-1" } as ScopedThreadRef;

describe("prepareDiffSelectionForPanelOpen", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
  });

  it("keeps the commit chosen in the graph when the diff panel opens", () => {
    const commitId = "a".repeat(40);
    useDiffPanelStore.getState().selectCommit(threadRef, commitId);

    prepareDiffSelectionForPanelOpen(threadRef);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ kind: "commit", commitId });
  });

  it("starts an ordinary panel opening on the branch diff", () => {
    useDiffPanelStore.getState().selectTurn(threadRef, "run-1" as RunId);

    prepareDiffSelectionForPanelOpen(threadRef);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ kind: "branch", baseRef: null });
  });
});
