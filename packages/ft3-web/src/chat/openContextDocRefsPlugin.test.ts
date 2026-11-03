import { describe, expect, it } from "vite-plus/test";

import { remarkLinkifyOpenContextDocRefs } from "./openContextDocRefsPlugin.ts";

const STABLE_ID = "fe000000-0000-4000-8000-000000000004";
const HREF = `oc://doc/${STABLE_ID}`;

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const paragraph = (...children: Node[]): Node => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

describe("remarkLinkifyOpenContextDocRefs", () => {
  it("turns a bare reference into a document href and leaves the label as typed", () => {
    const tree = paragraph({ type: "text", value: `See ${HREF} now` });

    remarkLinkifyOpenContextDocRefs()(tree);

    expect(tree.children?.[0]?.children).toEqual([
      { type: "text", value: "See " },
      { type: "link", url: HREF, children: [{ type: "text", value: HREF }] },
      { type: "text", value: " now" },
    ]);
  });

  it("links a reference that is the entire inline code span", () => {
    const tree = paragraph({ type: "inlineCode", value: HREF });

    remarkLinkifyOpenContextDocRefs()(tree);

    expect(tree.children?.[0]?.children).toEqual([
      { type: "link", url: HREF, children: [{ type: "text", value: HREF }] },
    ]);
  });

  it("leaves inline code with other content as code", () => {
    const tree = paragraph({ type: "inlineCode", value: `curl ${HREF}` });

    remarkLinkifyOpenContextDocRefs()(tree);

    expect(tree.children?.[0]?.children).toEqual([{ type: "inlineCode", value: `curl ${HREF}` }]);
  });

  it("leaves fenced code untouched", () => {
    const tree: Node = {
      type: "root",
      children: [{ type: "code", value: HREF }],
    };

    remarkLinkifyOpenContextDocRefs()(tree);

    expect(tree.children).toEqual([{ type: "code", value: HREF }]);
  });

  it("leaves existing links, unresolved runs, and non-document text alone", () => {
    const tree = paragraph(
      { type: "link", url: HREF, children: [{ type: "text", value: "ced policy" }] },
      { type: "text", value: " oc://doc/a/b and https://example.com/oc://doc/abc" },
    );

    remarkLinkifyOpenContextDocRefs()(tree);

    expect(tree.children?.[0]?.children).toEqual([
      { type: "link", url: HREF, children: [{ type: "text", value: "ced policy" }] },
      { type: "text", value: " oc://doc/a/b and https://example.com/oc://doc/abc" },
    ]);
  });
});
