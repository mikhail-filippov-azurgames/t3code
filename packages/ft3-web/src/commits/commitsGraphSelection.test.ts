import { describe, expect, it, vi } from "vite-plus/test";

import { createCommitSelectionBridge } from "./commitsGraphSelection.ts";

describe("commit graph selection bridge", () => {
  it("keeps programmatic focus selection from opening the commit again", () => {
    const onOpenCommit = vi.fn();
    const bridge = createCommitSelectionBridge(onOpenCommit);
    const selectCommit = vi.fn((commitId: string) => bridge.handleSelect(commitId));

    bridge.selectForFocus("commit-a", selectCommit);

    expect(selectCommit).toHaveBeenCalledWith("commit-a");
    expect(onOpenCommit).not.toHaveBeenCalled();
  });

  it("opens a commit selected by the user", () => {
    const onOpenCommit = vi.fn();
    const bridge = createCommitSelectionBridge(onOpenCommit);

    bridge.handleSelect("commit-a");

    expect(onOpenCommit).toHaveBeenCalledWith("commit-a");
  });

  it("restores user selections if programmatic selection throws", () => {
    const onOpenCommit = vi.fn();
    const bridge = createCommitSelectionBridge(onOpenCommit);

    expect(() =>
      bridge.selectForFocus("commit-a", () => {
        throw new Error("failed");
      }),
    ).toThrow("failed");
    bridge.handleSelect("commit-b");

    expect(onOpenCommit).toHaveBeenCalledWith("commit-b");
  });
});
