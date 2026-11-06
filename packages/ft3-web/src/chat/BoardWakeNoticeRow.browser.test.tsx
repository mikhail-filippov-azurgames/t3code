import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";
import { BoardWakeNoticeRow } from "./BoardWakeNoticeRow.tsx";

const wakeText = [
  "You are the lead for this board thread. You own the board and its end-to-end execution flow.",
  "",
  "Current card context:",
  "Executor finished its turn.",
  "Card card-1: status=review; readiness=ready; outcome=completed; failureStreak=0.",
].join("\n");

const briefText = [
  "You are the lead for this board thread.",
  "",
  "Current card context:",
  "The board brief was re-delivered by a human.",
].join("\n");

describe("BoardWakeNoticeRow", () => {
  it("collapses a wake into one system line by default", async () => {
    await using screen = await render(
      <BoardWakeNoticeRow message={{ id: "ft3:board:wake:12:thread-lead", text: wakeText }} />,
      { router: false },
    );

    const line = screen.getByRole("button");
    expect(line.element().textContent).toContain("⚙ Lead woken: Executor finished its turn.");
    expect(line.element().getAttribute("aria-expanded")).toBe("false");
    expect(screen.container.textContent).not.toContain("You are the lead for this board thread");
    expect(screen.container.querySelector("[data-ft3-board-wake-notice-body]")).toBeNull();
  });

  it("shows the full wake text after a click and hides it again", async () => {
    await using screen = await render(
      <BoardWakeNoticeRow message={{ id: "ft3:board:wake:12:thread-lead", text: wakeText }} />,
      { router: false },
    );

    const line = screen.getByRole("button");
    await userEvent.click(line);
    expect(line.element().getAttribute("aria-expanded")).toBe("true");
    expect(screen.container.textContent).toContain("You are the lead for this board thread");
    expect(screen.container.querySelector("[data-ft3-board-wake-notice-body]")).not.toBeNull();

    await userEvent.click(line);
    expect(line.element().getAttribute("aria-expanded")).toBe("false");
    expect(screen.container.textContent).not.toContain("You are the lead for this board thread");
  });

  it("labels a re-delivered brief as a lead brief", async () => {
    await using screen = await render(
      <BoardWakeNoticeRow message={{ id: "ft3:board:brief:thread-lead:nonce", text: briefText }} />,
      { router: false },
    );

    expect(screen.getByRole("button").element().textContent).toContain("⚙ Lead brief");
  });

  it("renders nothing for a person's message", async () => {
    await using screen = await render(
      <BoardWakeNoticeRow
        message={{ id: "11111111-1111-4111-8111-111111111111", text: "hello" }}
      />,
      { router: false },
    );

    expect(screen.container.textContent).toBe("");
    expect(screen.container.querySelector("[data-ft3-board-wake-notice]")).toBeNull();
  });

  it("collapses a mail wake to kind, sender and task, expanding to the letter body", async () => {
    const text = [
      'New answer letter from implementation in mail task "Refactor":',
      "",
      "The module is split and the tests pass.",
      "",
      'Reply with mail_send: taskId "task-1", to "lead", kind "answer".',
    ].join("\n");
    await using screen = await render(
      <BoardWakeNoticeRow message={{ id: "mail:wake:delivery:letter-1", text }} />,
      { router: false },
    );

    const line = screen.getByRole("button");
    expect(line.element().textContent).toContain(
      "✉ Mail answer letter from implementation: Refactor",
    );
    expect(screen.container.textContent).not.toContain("The module is split");

    await userEvent.click(line);
    expect(line.element().getAttribute("aria-expanded")).toBe("true");
    expect(screen.container.textContent).toContain("The module is split and the tests pass.");
    expect(screen.container.textContent).not.toContain("Reply with mail_send");
    // The expanded body is the letter itself, without the server header line.
    const body = screen.container.querySelector("[data-ft3-board-wake-notice-body]");
    expect(body?.textContent).not.toContain("New answer letter");
  });
});
