import { useMemo } from "react";

import { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";
import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { useEnvironmentQuery } from "~/state/query";
import type { EnvironmentId } from "@t3tools/contracts";

import { commitsEnvironment } from "./state.ts";

export interface CommitDiffPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly commitId: string;
}

/** Renders one commit's patch inside V2's diff panel shell. */
export function CommitDiffPanel({ environmentId, cwd, commitId }: CommitDiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const query = useEnvironmentQuery(
    cwd === null
      ? null
      : commitsEnvironment.commitDiff({ environmentId, input: { cwd, commit: commitId } }),
  );
  const patch = query.data?.patch;
  const renderable = useMemo(
    () => getRenderablePatch(patch, `commit:${commitId}`),
    [commitId, patch],
  );
  const items = useMemo(
    () =>
      renderable?.kind === "files"
        ? renderable.files.map((fileDiff) => ({
            id: buildFileDiffIdentityKey(fileDiff),
            type: "diff" as const,
            fileDiff,
            annotations: [],
            collapsed: false,
            version: buildFileDiffContentVersion(fileDiff),
          }))
        : [],
    [renderable],
  );

  if (cwd === null) {
    return <PanelMessage text="This thread has no working tree to read a commit from." />;
  }
  if (query.error !== null) {
    return <PanelMessage text={query.error} />;
  }
  if (query.isPending && query.data === null) {
    return <PanelMessage text={`Loading commit ${commitId.slice(0, 7)}...`} />;
  }
  if (query.data?.truncated === true) {
    return <PanelMessage text="This commit diff exceeds the size limit." />;
  }
  if (items.length === 0) {
    return <PanelMessage text="No patch available for this commit." />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <StyledDiffCodeView
        className="h-full min-h-0 overflow-auto"
        items={items}
        options={{
          diffStyle: "unified",
          lineDiffType: "none",
          overflow: "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme,
          stickyHeaders: true,
        }}
      />
    </div>
  );
}

function PanelMessage({ text }: { readonly text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
      {text}
    </div>
  );
}
