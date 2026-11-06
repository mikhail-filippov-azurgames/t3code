import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MailLetter } from "@t3tools/ft3-mail/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ReactElement } from "react";

import { render } from "../../../../apps/web/test/render";
import { TimelineRowCtx, type TimelineWorkEntry } from "~/components/chat/timelineRowContext";
import { MailNotificationRow } from "./MailNotificationRow.tsx";

const SUMMARY = 'Mail answer letter from implementation/contracts in "Refactor"';
const CREATED_AT = "2026-03-17T19:12:28.000Z";
const SENDER_THREAD = ThreadId.make("thread-sender");
const LEAD_THREAD = ThreadId.make("thread-lead");
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const LETTER = {
  letterId: "letter-1",
  taskId: "task-1",
  sequence: 1,
  senderThreadId: SENDER_THREAD,
  recipient: "lead",
  kind: "answer",
  body: "The module is split and the tests pass.",
  replyToLetterId: null,
  sourceLetterId: null,
  planPhase: null,
  planStep: null,
  planSha256: null,
  planDocId: null,
  classifierKind: null,
  classifierConfidence: null,
  kindDisputed: false,
  leadKind: null,
  clientRequestId: "request:letter",
  requestFingerprint: "fp",
  createdAt: CREATED_AT,
} satisfies MailLetter;

const letterQuery = vi.hoisted(() => ({
  input: null as { readonly letterId: string; readonly threadId: string } | null,
  state: "idle" as "idle" | "pending" | "ready" | "error" | "unsupported",
  refresh: vi.fn(),
}));

vi.mock(import("../mail/MailTabContent.tsx"), () => ({
  useBoardMailLetter: (_environmentId: unknown, input: typeof letterQuery.input) => {
    letterQuery.input = input;
    return {
      data: letterQuery.state === "ready" ? { letter: LETTER, effectiveKind: LETTER.kind } : null,
      dataUpdatedAt: 0,
      error:
        letterQuery.state === "error"
          ? "boom"
          : letterQuery.state === "unsupported"
            ? "Unknown request tag: mail.letter"
            : null,
      failure: null,
      isPending: letterQuery.state === "pending",
      isSuccess: letterQuery.state === "ready",
      refresh: letterQuery.refresh,
    };
  },
}));

vi.mock(import("../mail/mail.logic.ts"), () => ({
  mailTasksUnsupported: (error: string | null) =>
    error !== null && error.startsWith("Unknown request tag"),
}));

function workEntry(): TimelineWorkEntry {
  return {
    id: "work-mail-1",
    createdAt: CREATED_AT,
    itemType: "notification",
    tone: "info",
    label: SUMMARY,
    structuredPayload: {
      type: "notification",
      outcome: "updated",
      source: {
        kind: "delegated_task",
        taskIds: [],
        childThreadId: SENDER_THREAD,
        mail: {
          taskId: "task-1",
          letterId: "letter-1",
          preview: "The module is split.",
        },
      },
    },
  } as unknown as TimelineWorkEntry;
}

function setup(state: typeof letterQuery.state = "idle") {
  letterQuery.state = state;
  letterQuery.input = null;
  letterQuery.refresh.mockClear();
}

// No links render, so no router is needed. The row icon reads the theme from context.
const withTimelineContext = (node: ReactElement) => (
  <TimelineRowCtx.Provider value={{ resolvedTheme: "light" } as never}>
    {node}
  </TimelineRowCtx.Provider>
);
const renderRow = (node: ReactElement) => render(withTimelineContext(node), { router: false });

const mailRow = (onOpenThread: (threadId: ThreadId) => void) => (
  <MailNotificationRow
    workEntry={workEntry()}
    workspaceRoot={undefined}
    mail={{ taskId: "task-1", letterId: "letter-1", preview: "The module is split." }}
    senderThreadId={SENDER_THREAD}
    threadId={LEAD_THREAD}
    environmentId={ENVIRONMENT_ID}
    timestampFormat="locale"
    onOpenThread={onOpenThread}
  />
);

describe("MailNotificationRow", () => {
  it("shows the preview without fetching, then expands to the letter body", async () => {
    setup("ready");
    await using screen = await renderRow(mailRow(() => {}));

    expect(letterQuery.input).toBeNull();
    expect(screen.container.textContent).toContain(SUMMARY);
    expect(screen.container.textContent).toContain("The module is split.");
    expect(screen.container.textContent).not.toContain("tests pass");

    const row = screen.getByRole("button", { name: new RegExp(SUMMARY) });
    expect(row.element().getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(row);
    expect(letterQuery.input).toEqual({ letterId: "letter-1", threadId: LEAD_THREAD });
    expect(row.element().getAttribute("aria-expanded")).toBe("true");
    expect(screen.container.textContent).toContain("The module is split and the tests pass.");

    await userEvent.click(row);
    expect(row.element().getAttribute("aria-expanded")).toBe("false");
    expect(screen.container.textContent).not.toContain("tests pass");
  });

  it("shows loading and error states with a retry", async () => {
    setup("pending");
    await using screen = await renderRow(mailRow(() => {}));

    await userEvent.click(screen.getByRole("button", { name: new RegExp(SUMMARY) }));
    expect(screen.container.textContent).toContain("Loading letter…");

    letterQuery.state = "error";
    await screen.rerender(withTimelineContext(mailRow(() => {})));
    expect(screen.container.textContent).toContain("Could not load the letter.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(letterQuery.refresh).toHaveBeenCalledTimes(1);
  });

  it("opens the sender thread from Open subagent without expanding", async () => {
    setup("ready");
    const onOpenThread = vi.fn();
    await using screen = await renderRow(mailRow(onOpenThread));

    await userEvent.click(screen.getByRole("button", { name: "Open subagent thread" }));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD);
    expect(screen.container.textContent).not.toContain("tests pass");
  });
});
