import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../../apps/web/test/render.tsx";
import { MarkdownFrontmatterBlock } from "./MarkdownFrontmatterBlock.tsx";

describe("MarkdownFrontmatterBlock", () => {
  it("shows YAML without its fence separators", async () => {
    await using screen = await render(
      <MarkdownFrontmatterBlock frontmatter={"status: agreed\nrevision: 6"} />,
      { router: false },
    );

    const block = screen.container.querySelector("[data-ft3-markdown-frontmatter]");
    expect(block?.textContent).toBe("status: agreed\nrevision: 6");
    expect(block?.textContent).not.toContain("---");
  });
});
