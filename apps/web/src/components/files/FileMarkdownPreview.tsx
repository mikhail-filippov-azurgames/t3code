import type { ScopedThreadRef } from "@t3tools/contracts";
import { extractMarkdownFrontmatter, MarkdownFrontmatterPreview } from "@t3tools/ft3-web/files";

import ChatMarkdown from "~/components/ChatMarkdown";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

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
  if (frontmatter !== null) {
    return (
      <MarkdownFrontmatterPreview
        cwd={props.cwd}
        text={props.text}
        frontmatter={frontmatter}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        onTaskListChange={props.onTaskListChange}
      />
    );
  }

  return (
    <ChatMarkdown
      text={maskMarkdownFrontmatter(props.text)}
      cwd={props.cwd}
      imageBaseDir={imageBaseDir}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
      className="mx-auto max-w-4xl px-6 py-5"
      onTaskListChange={props.onTaskListChange}
    />
  );
}
