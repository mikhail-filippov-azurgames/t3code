import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  prepareDiffSelectionForPanelOpen,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

const threadRef = { environmentId: "environment-1", threadId: "thread-1" } as ScopedThreadRef;

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
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

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
});
