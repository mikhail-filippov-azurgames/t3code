import { describe, expect, it } from "vite-plus/test";

import { COMMIT_MENTION_HREF_PREFIX, remarkLinkifyCommitMentions } from "./commitMentionsPlugin.ts";

const FULL_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const SHORT = FULL_SHA.slice(0, 7);

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

describe("remarkLinkifyCommitMentions", () => {
  it("turns a resolved token into a commit href and leaves the label as typed", () => {
    const tree: Node = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: `See ${SHORT} now` }] }],
    };

    remarkLinkifyCommitMentions(new Map([[SHORT, FULL_SHA]]))(tree);

    expect(tree.children?.[0]?.children).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        url: `${COMMIT_MENTION_HREF_PREFIX}${FULL_SHA}`,
        children: [{ type: "text", value: SHORT }],
      },
      { type: "text", value: " now" },
    ]);
  });

  it("leaves unresolved tokens and non-prose nodes untouched", () => {
    const tree: Node = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: `See ${SHORT}` }] },
        { type: "link", url: "https://example.com", children: [{ type: "text", value: FULL_SHA }] },
        { type: "code", value: FULL_SHA },
      ],
    };

    remarkLinkifyCommitMentions(new Map())(tree);

    expect(tree.children?.[0]?.children?.map((child) => child.value ?? "").join("")).toBe(
      `See ${SHORT}`,
    );
    expect(tree.children?.[0]?.children?.some((child) => child.type === "link")).toBe(false);
    expect(tree.children?.[1]?.type).toBe("link");
    expect(tree.children?.[2]?.type).toBe("code");
  });
});
