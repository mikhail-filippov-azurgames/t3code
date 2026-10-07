import { BoardCardId, ThreadId, type BoardCard } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

import { BoardCardDetailDialog } from "./BoardCardDetailDialog";

const createdAt = "2026-10-06T00:00:00.000Z";
const card: BoardCard = {
  cardId: BoardCardId.make("card-1"),
  orchestratorThreadId: ThreadId.make("orchestrator-thread"),
  title: "Do the thing",
  body: "",
  status: "in_progress",
  readiness: "ready",
  readinessNote: null,
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

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

let renderer: ReactTestRenderer | undefined;

function render(onRequest: (card: BoardCard, text: string) => void): ReactTestRenderer {
  let created!: ReactTestRenderer;
  act(() => {
    created = create(
      <BoardCardDetailDialog
        card={card}
        events={[]}
        executorTitle={null}
        busy={false}
        onClose={() => {}}
        onStart={() => {}}
        onToggleArchive={() => {}}
        onRequest={onRequest}
        onOpenExecutor={() => {}}
      />,
    );
  });
  renderer = created;
  return created;
}

describe("BoardCardDetailDialog coordinator presets", () => {
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

  it("sends the human's work-on-card wording for the work-on-it preset", () => {
    const onRequest = vi.fn();
    const view = render(onRequest);

    const button = view.root.find(
      (node) => node.type === "button" && textContent(node) === "Ask to work on it",
    );
    act(() => button.props.onClick());

    expect(onRequest).toHaveBeenCalledWith(card, "Работай над карточкой card-1");
  });
});
