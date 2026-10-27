import { describe, expect, it } from "vite-plus/test";

import { extractMarkdownFrontmatter } from "./markdownFrontmatter.ts";

describe("extractMarkdownFrontmatter", () => {
  it("keeps indentation of nested YAML keys and lists", () => {
    expect(
      extractMarkdownFrontmatter(
        "---\nstatus: draft\ntargets:\n  - oc://doc/a\ntarget_revisions:\n  oc://doc/a: 1\n---\n# Body\n",
      ),
    ).toBe("status: draft\ntargets:\n  - oc://doc/a\ntarget_revisions:\n  oc://doc/a: 1");
  });

  it("normalizes CRLF and CR line endings and accepts a BOM or ellipsis closer", () => {
    expect(extractMarkdownFrontmatter("\uFEFF---\rstatus: agreed\rrevision: 6\r...\r# Body")).toBe(
      "status: agreed\nrevision: 6",
    );
  });

  it("returns an empty value for empty frontmatter", () => {
    expect(extractMarkdownFrontmatter("---\n---\n# Body\n")).toBe("");
  });

  it("leaves unterminated or non-leading fences untouched", () => {
    expect(extractMarkdownFrontmatter("---\nstatus: draft\n\n# Body\n")).toBeNull();
    expect(extractMarkdownFrontmatter("# Body\n---\nstatus: draft\n---\n")).toBeNull();
  });
});