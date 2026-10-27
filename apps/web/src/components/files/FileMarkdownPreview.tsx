import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";
import {
  extractMarkdownFrontmatter,
  MarkdownFrontmatterBlock,
} from "@t3tools/ft3-web/files";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;
  const frontmatter = extractMarkdownFrontmatter(props.text);

  return (
    <>
      {frontmatter === null ? null : <MarkdownFrontmatterBlock frontmatter={frontmatter} />}
      <ChatMarkdown
        text={maskMarkdownFrontmatter(props.text)}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        className={
          frontmatter === null
            ? "mx-auto max-w-4xl px-6 py-5"
            : "mx-auto max-w-4xl px-6 pt-2 pb-5"
        }
        onTaskListChange={props.onTaskListChange}
      />
    </>
  );
}
