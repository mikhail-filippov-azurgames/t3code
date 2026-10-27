import { describe, expect, it } from "vite-plus/test";

import { chatCopyAnchorMarkdown } from "./chatCopyFilters";

describe("chatCopyAnchorMarkdown", () => {
  it("keeps an http destination as a markdown link", () => {
    expect(chatCopyAnchorMarkdown(" docs ", "https://example.com/docs")).toBe(
      "[docs](https://example.com/docs)",
    );
  });

  it("collapses internal schemes and fragments to their label", () => {
    expect(
      chatCopyAnchorMarkdown("ced policy", "oc://doc/11111111-1111-1111-1111-111111111111"),
    ).toBe("ced policy");
    expect(chatCopyAnchorMarkdown("abcdef1", "#t3-commit-abcdef1")).toBe("abcdef1");
    expect(chatCopyAnchorMarkdown("run", "javascript:alert(1)")).toBe("run");
  });

  it("drops an empty label but keeps a bare destination", () => {
    expect(chatCopyAnchorMarkdown("  ", "https://example.com")).toBe("");
    expect(chatCopyAnchorMarkdown("https://example.com", "https://example.com")).toBe(
      "https://example.com",
    );
  });
});
