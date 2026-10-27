import type { ScopedThreadRef } from "@t3tools/contracts";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

import ChatMarkdown from "~/components/ChatMarkdown";
import { MarkdownFrontmatterBlock } from "./MarkdownFrontmatterBlock.tsx";

/** Document preview with the upstream masked body plus the ft3 metadata block. */
export function MarkdownFrontmatterPreview(props: {
  readonly cwd: string;
  readonly text: string;
  readonly frontmatter: string;
  readonly imageBaseDir: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  return (
    <>
      <MarkdownFrontmatterBlock frontmatter={props.frontmatter} />
      <ChatMarkdown
        text={maskMarkdownFrontmatter(props.text)}
        cwd={props.cwd}
        imageBaseDir={props.imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        className="mx-auto max-w-4xl px-6 pt-2 pb-5"
        onTaskListChange={props.onTaskListChange}
      />
    </>
  );
}
