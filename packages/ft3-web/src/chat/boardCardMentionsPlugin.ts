import type { BoardCardLookupMatch } from "@t3tools/ft3-board/contracts";

import {
  boardCardMentionTextSegments,
  boardCardMentionTokenFromInlineCode,
} from "./boardCardMentions.ts";

interface MarkdownNode {
  type: string;
  value?: unknown;
  url?: string;
  children?: MarkdownNode[];
}

export const BOARD_CARD_MENTION_HREF_PREFIX = "#t3-board-card-";

export function boardCardMentionHref(cardId: string): string {
  return `${BOARD_CARD_MENTION_HREF_PREFIX}${cardId}`;
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
 * card. The renderer turns these hrefs into chips; an unresolved token stays
 * plain text.
 */
export function remarkLinkifyBoardCardMentions(matches: ReadonlyMap<string, BoardCardLookupMatch>) {
  return (tree: MarkdownNode) => {
    const mentionNodes = (value: string): MarkdownNode[] =>
      boardCardMentionTextSegments(value, matches).map((segment) =>
        segment.match
          ? {
              type: "link",
              url: boardCardMentionHref(String(segment.match.card.cardId)),
              children: [{ type: "text", value: segment.text }],
            }
          : { type: "text", value: segment.text },
      );

    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && typeof child.value === "string") {
          return mentionNodes(child.value);
        }
        if (child.type === "inlineCode" && typeof child.value === "string") {
          const token = boardCardMentionTokenFromInlineCode(child.value);
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
