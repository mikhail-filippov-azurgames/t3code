import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import ChatMarkdown from "~/components/ChatMarkdown";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { render } from "../../../../apps/web/test/render";
import { CommitMentionChip } from "./CommitMentionChip";
import { remarkLinkifyCommitMentions } from "./commitMentionsPlugin";

const FULL_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const SHORT = FULL_SHA.slice(0, 7);
const threadRef = { environmentId: "env-1", threadId: "thread-1" } as ScopedThreadRef;

function selectContents(element: Element): Selection {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("CommitMentionChip", () => {
  it("selects the commit in the diff panel when the chip is clicked", async () => {
    // No router: the chip opens the right panel, not a route.
    await using screen = await render(
      <ChatMarkdown
        text={`Fixed in ${SHORT}.`}
        cwd="/repo"
        threadRef={threadRef}
        extraRemarkPlugins={[() => remarkLinkifyCommitMentions(new Map([[SHORT, FULL_SHA]]))]}
      />,
      { router: false },
    );

    const chip = screen.getByRole("button", { name: `Open commit ${SHORT}` });
    expect((chip.element() as HTMLElement).dataset.commitMention).toBe(FULL_SHA);

    await userEvent.click(chip);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ kind: "commit", commitId: FULL_SHA });
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
      "diff",
    );
  });

  it("copies the typed SHA as plain text and drops the chip from rich HTML", async () => {
    await using screen = await render(
      <p>
        See <CommitMentionChip sha={FULL_SHA} label={SHORT} onOpen={() => {}} /> now
      </p>,
      { router: false },
    );

    const payload = chatMarkdownClipboardPayload(selectContents(screen.container));
    window.getSelection()?.removeAllRanges();

    expect(payload?.text).toBe(`See ${SHORT} now`);
    expect(payload?.html).not.toContain(SHORT);
    expect(payload?.html).not.toContain("<button");
  });
});
