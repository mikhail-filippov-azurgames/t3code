import { describe, expect, it } from "vite-plus/test";

import { parseMarkdownFileLink } from "@t3tools/client-runtime/markdown-links";

import {
  literalMarkdownLinkDestination,
  readMarkdownLinkDestination,
} from "./markdown-link-destination";

describe("readMarkdownLinkDestination", () => {
  it("keeps backslash separators before punctuation intact", () => {
    expect(
      readMarkdownLinkDestination(
        String.raw`C:\Users\User\.opencontext\contexts\kick-the-buddy\notes.md`,
      ),
    ).toBe(String.raw`C:\Users\User\.opencontext\contexts\kick-the-buddy\notes.md`);
  });

  it("stops at a title but keeps the destination", () => {
    expect(readMarkdownLinkDestination(String.raw`C:\Users\mike\.git\config "local"`)).toBe(
      String.raw`C:\Users\mike\.git\config`,
    );
  });

  it("reads angle-bracketed destinations", () => {
    expect(readMarkdownLinkDestination(String.raw`<C:\Users\a\.b\c.md>`)).toBe(
      String.raw`C:\Users\a\.b\c.md`,
    );
  });

  it("keeps balanced parentheses inside the destination", () => {
    expect(readMarkdownLinkDestination(String.raw`C:\a\b(1).md`)).toBe(String.raw`C:\a\b(1).md`);
  });

  it("leaves ordinary destinations untouched", () => {
    expect(readMarkdownLinkDestination("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
  });

  it("returns null for an empty destination", () => {
    expect(readMarkdownLinkDestination(")")).toBeNull();
  });
});

describe("literalMarkdownLinkDestination", () => {
  it("recovers the exact path CommonMark unescaped in an inline link", () => {
    const markdown = String.raw`[chn-02-dependency-foundation-implementation-plan.md](C:\Users\User\.opencontext\contexts\kick-the-buddy\execution-plans\in-progress\china-build-migration\chn-02-dependency-foundation-implementation-plan.md)`;
    const labelEnd = markdown.indexOf("]");
    const node = {
      type: "link",
      position: { start: { offset: 0 }, end: { offset: markdown.length } },
      children: [{ position: { end: { offset: labelEnd } } }],
    };

    const literal = literalMarkdownLinkDestination(markdown, node);

    expect(literal).toBe(
      String.raw`C:\Users\User\.opencontext\contexts\kick-the-buddy\execution-plans\in-progress\china-build-migration\chn-02-dependency-foundation-implementation-plan.md`,
    );
    expect(parseMarkdownFileLink(literal ?? "")?.path).toBe(
      String.raw`C:\Users\User\.opencontext\contexts\kick-the-buddy\execution-plans\in-progress\china-build-migration\chn-02-dependency-foundation-implementation-plan.md`,
    );
  });

  it("recovers a definition destination", () => {
    const markdown = String.raw`[source]: C:\Users\shawn\.opencontext\src\main.ts`;
    const node = {
      type: "definition",
      position: { start: { offset: 0 }, end: { offset: markdown.length } },
    };

    expect(literalMarkdownLinkDestination(markdown, node)).toBe(
      String.raw`C:\Users\shawn\.opencontext\src\main.ts`,
    );
  });

  it("returns null without a usable source range", () => {
    expect(literalMarkdownLinkDestination("[](C:\\a\\.b)", { type: "link" })).toBeNull();
    expect(
      literalMarkdownLinkDestination("plain text", {
        type: "text",
        position: { start: { offset: 0 }, end: { offset: 10 } },
      }),
    ).toBeNull();
  });
});
