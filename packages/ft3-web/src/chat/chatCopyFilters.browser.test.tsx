import { describe, expect, it, vi } from "vite-plus/test";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";

function selectContents(element: Element): Selection {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function payloadFor(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  try {
    const payload = chatMarkdownClipboardPayload(selectContents(container));
    if (!payload) throw new Error("expected a clipboard payload");
    return payload;
  } finally {
    window.getSelection()?.removeAllRanges();
    container.remove();
  }
}

const FULL_SHA = "abcdef1234567890abcdef1234567890abcdef12";

describe("chat copy filters", () => {
  it("keeps a chip's canonical commit SHA in the plain-text flavor", () => {
    const { text } = payloadFor(
      `<p>See <button data-markdown-copy="${FULL_SHA}">${FULL_SHA.slice(0, 7)}</button> now</p>`,
    );

    expect(text).toContain(FULL_SHA);
  });

  it("drops chip buttons from the rich-text flavor", () => {
    const { html } = payloadFor(
      `<p>See <button data-markdown-copy="${FULL_SHA}">${FULL_SHA.slice(0, 7)}</button> now</p>`,
    );

    expect(html).not.toContain(FULL_SHA);
    expect(html).not.toContain("<button");
  });

  it("keeps file-link chips in the rich-text flavor", () => {
    const { html } = payloadFor(
      `<button class="chat-markdown-file-link" data-markdown-copy="\`src/foo.ts\`"><span>src/foo.ts</span></button>`,
    );

    expect(html).toContain("src/foo.ts");
  });

  it("strips an OpenContext document URI, keeping only its label", () => {
    const stableId = "11111111-1111-1111-1111-111111111111";
    const { text } = payloadFor(`<p><a href="oc://doc/${stableId}">ced policy</a></p>`);

    expect(text).toBe("ced policy");
    expect(text).not.toContain("oc://");
  });

  it("keeps an http link as markdown", () => {
    const { text } = payloadFor(`<p>See <a href="https://example.com/docs">docs</a> now</p>`);

    expect(text).toContain("[docs](https://example.com/docs)");
  });

  it("never copies hidden chrome or select-none text", () => {
    const { text } = payloadFor(
      `<p>visible<span aria-hidden="true">hidden</span><span class="select-none">none</span><span class="sr-only">sr</span><script>bad()</script></p>`,
    );

    expect(text).toBe("visible");
  });

  it("keeps commit SHAs inside a copied code block", () => {
    const { text } = payloadFor(`<div><pre><code>git show ${FULL_SHA}</code></pre></div>`);

    expect(text).toBe(`git show ${FULL_SHA}`);
  });

  it("does not filter the whole-message copy payload", async () => {
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const message = `Fixed in ${FULL_SHA}.`;
    try {
      await writeTextToClipboard(message, "message");
      expect(writeText).toHaveBeenCalledWith(message);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
