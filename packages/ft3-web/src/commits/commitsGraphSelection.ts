export function createCommitSelectionBridge(onOpenCommit: (commitId: string) => void) {
  let selectingForFocus = false;

  return {
    handleSelect(commitId: string) {
      if (!selectingForFocus) onOpenCommit(commitId);
    },
    selectForFocus(commitId: string, selectCommit: (commitId: string) => void) {
      selectingForFocus = true;
      try {
        selectCommit(commitId);
      } finally {
        selectingForFocus = false;
      }
    },
  };
}
