import { commitMentionTextSegments, commitMentionTokenFromInlineCode } from "./commitMentions.ts";

interface MarkdownNode {
  type: string;
  value?: unknown;
  url?: string;
  children?: MarkdownNode[];
}

export const COMMIT_MENTION_HREF_PREFIX = "#t3-commit-";

export function commitMentionHref(sha: string): string {
  return `${COMMIT_MENTION_HREF_PREFIX}${sha}`;
}

const SKIPPED_NODE_TYPES = new Set([
  "link",
  "linkReference",
  "code",
  "html",
  "image",
  "imageReference",
]);

/**
 * Links every prose or inline-code token that the server confirmed as one
 * commit. The renderer turns these hrefs into chips; an unresolved token stays
 * plain text.
 */
export function remarkLinkifyCommitMentions(matches: ReadonlyMap<string, string>) {
  return (tree: MarkdownNode) => {
    const mentionNodes = (value: string): MarkdownNode[] =>
      commitMentionTextSegments(value, matches).map((segment) =>
        segment.sha === null
          ? { type: "text", value: segment.text }
          : {
              type: "link",
              url: commitMentionHref(segment.sha),
              children: [{ type: "text", value: segment.text }],
            },
      );

    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && typeof child.value === "string") {
          return mentionNodes(child.value);
        }
        if (child.type === "inlineCode" && typeof child.value === "string") {
          const token = commitMentionTokenFromInlineCode(child.value);
          return token !== null && matches.has(token) ? mentionNodes(child.value) : [child];
        }
        if (SKIPPED_NODE_TYPES.has(child.type)) return [child];
        visit(child);
        return [child];
      });
    };

    visit(tree);
  };
}
