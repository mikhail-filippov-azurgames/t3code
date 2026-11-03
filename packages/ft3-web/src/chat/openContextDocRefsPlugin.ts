import {
  openContextDocRefFromInlineCode,
  openContextDocTextSegments,
} from "./openContextDocRefs.ts";

interface MarkdownNode {
  type: string;
  value?: unknown;
  url?: string;
  children?: MarkdownNode[];
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
 * Links every bare `oc://doc/<id>` in prose and a whole inline-code reference.
 * The anchor renderer turns those hrefs into document chips; fenced code and
 * longer inline code keep their text.
 */
export function remarkLinkifyOpenContextDocRefs() {
  return (tree: MarkdownNode) => {
    const refNodes = (value: string): MarkdownNode[] =>
      openContextDocTextSegments(value).map((segment) =>
        segment.doc === null
          ? { type: "text", value: segment.text }
          : {
              type: "link",
              url: segment.doc.href,
              children: [{ type: "text", value: segment.text }],
            },
      );

    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && typeof child.value === "string") {
          return refNodes(child.value);
        }
        if (child.type === "inlineCode" && typeof child.value === "string") {
          return openContextDocRefFromInlineCode(child.value) !== null
            ? refNodes(child.value)
            : [child];
        }
        if (SKIPPED_NODE_TYPES.has(child.type)) return [child];
        visit(child);
        return [child];
      });
    };

    visit(tree);
  };
}
