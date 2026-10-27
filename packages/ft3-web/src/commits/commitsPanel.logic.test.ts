import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  findResolvedCommit,
  selectCommitFromGraph,
  selectedCommitId,
} from "./commitsPanel.logic.ts";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as ScopedThreadRef;

describe("selectCommitFromGraph", () => {
  it("selects the clicked commit before opening the diff panel", () => {
    const calls: string[] = [];
    const selectCommit = vi.fn(() => calls.push("select"));
    const openDiffPanel = vi.fn(() => calls.push("open"));

    selectCommitFromGraph({
      threadRef,
      commitId: "a".repeat(40),
      selectCommit,
      openDiffPanel,
    });

    expect(selectCommit).toHaveBeenCalledWith(threadRef, "a".repeat(40));
    expect(openDiffPanel).toHaveBeenCalledWith(threadRef);
    expect(calls).toEqual(["select", "open"]);
  });
});

describe("findResolvedCommit", () => {
  const commit = "a".repeat(40);

  it("returns the repository where the server found the commit", () => {
    expect(
      findResolvedCommit({
        commitId: commit.slice(0, 9),
        commits: [{ commit, cwd: "/project/nested" }],
      }),
    ).toEqual({ commit, cwd: "/project/nested" });
  });

  it("returns null for an unresolved commit", () => {
    expect(findResolvedCommit({ commitId: commit, commits: [] })).toBeNull();
  });
});

describe("selectedCommitId", () => {
  it("returns the commit shown by the diff panel and ignores other selections", () => {
    expect(selectedCommitId({ kind: "commit", commitId: "abc" })).toBe("abc");
    expect(selectedCommitId({ kind: "unstaged" })).toBeNull();
    expect(selectedCommitId(undefined)).toBeNull();
  });
});
