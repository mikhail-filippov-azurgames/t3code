import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { resolvePathLinkTarget } from "~/terminal-links";

const FRONTMATTER_FENCE = /^---[ \t]*\r?$/;

export type MarkdownFrontmatterSplit = {
  /** YAML between the fences, CRLF normalized; null when the text is not frontmatter. */
  readonly frontmatter: string | null;
  /** Markdown after the closing fence, or the whole text when unsplit. */
  readonly body: string;
  /** Index of body[0] inside the original text; maps task offsets back onto the file. */
  readonly bodyStart: number;
};

export function splitMarkdownFrontmatter(text: string): MarkdownFrontmatterSplit {
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  if (firstLineEnd === -1 || !FRONTMATTER_FENCE.test(firstLine)) {
    return { frontmatter: null, body: text, bodyStart: 0 };
  }

  const yamlStart = firstLineEnd + 1;
  let lineStart = yamlStart;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const line = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
    if (FRONTMATTER_FENCE.test(line)) {
      const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
      return {
        frontmatter: text.slice(yamlStart, lineStart).replaceAll("\r\n", "\n").replace(/\n$/, ""),
        body: text.slice(bodyStart),
        bodyStart,
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return { frontmatter: null, body: text, bodyStart: 0 };
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const { frontmatter, body, bodyStart } = useMemo(
    () => splitMarkdownFrontmatter(props.text),
    [props.text],
  );
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;

  const reportTaskListChange = props.onTaskListChange;
  const onTaskListChange =
    reportTaskListChange === undefined
      ? undefined
      : bodyStart === 0
        ? reportTaskListChange
        : (input: { markerOffset: number; checked: boolean }) => {
            reportTaskListChange({
              markerOffset: input.markerOffset + bodyStart,
              checked: input.checked,
            });
          };

  return (
    <>
      {frontmatter !== null && (
        <div className="mx-auto max-w-4xl px-6 pt-5">
          <pre className="overflow-x-auto rounded-lg bg-(--code-background) px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre text-(--code-foreground)">
            {frontmatter}
          </pre>
        </div>
      )}
      <ChatMarkdown
        text={body}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        className={
          frontmatter !== null ? "mx-auto max-w-4xl px-6 pt-2 pb-5" : "mx-auto max-w-4xl px-6 py-5"
        }
        onTaskListChange={onTaskListChange}
      />
    </>
  );
}
