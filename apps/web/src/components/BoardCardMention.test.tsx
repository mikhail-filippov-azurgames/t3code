import {
  BoardCardId,
  BoardCardLookupToken,
  ThreadId,
  type BoardCard,
  type BoardCardLookupMatch,
} from "@t3tools/contracts";
import { type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
}));

import { BoardCardMentionButton } from "./ChatMarkdown";

const createdAt = "2026-01-01T00:00:00.000Z";
const card: BoardCard = {
  cardId: BoardCardId.make("b71111aa-0000-4000-8000-000000000001"),
  orchestratorThreadId: ThreadId.make("owner-thread"),
  title: "Fix the board",
  body: "",
  status: "todo",
  readiness: "needs_human",
  readinessNote:
    "Which migration order should the executor use?\nContext: the review names three steps.\nQuestion: may it start with step two?",
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt,
  updatedAt: createdAt,
};

const match: BoardCardLookupMatch = {
  token: BoardCardLookupToken.make("b71111aa"),
  card,
  orchestratorThreadTitle: "Owner chat",
  recentEvents: [],
};

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

let renderer: ReactTestRenderer | undefined;

describe("BoardCardMentionButton readiness note", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = undefined;
    }
    vi.unstubAllGlobals();
  });

  it("shows only the first note line in one truncated line", () => {
    act(() => {
      renderer = create(<BoardCardMentionButton match={match} onPin={() => {}} />);
    });

    const notes = renderer!.root.findAll(
      (node) =>
        node.type === "span" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("truncate"),
    );
    expect(notes).toHaveLength(1);
    const text = textContent(notes[0]!);
    expect(text).toContain("Which migration order should the executor use?");
    expect(text).not.toContain("Context: the review names three steps.");
    expect(text).not.toContain("Question: may it start with step two?");
  });
});
