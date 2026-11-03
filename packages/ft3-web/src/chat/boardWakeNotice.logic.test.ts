import { describe, expect, it } from "vite-plus/test";

import {
  boardWakeNoticeKind,
  boardWakeNoticeLine,
  boardWakeNoticeOf,
} from "./boardWakeNotice.logic.ts";

const wakeText = [
  "You are the lead for this board thread. You own the board and its end-to-end execution flow.",
  "",
  "Current card context:",
  "Executor finished its turn.",
  "Executor thread: thread-executor.",
  "Card card-1: status=review; readiness=ready; outcome=completed; failureStreak=0.",
].join("\n");

const nudgeText = [
  "This is an automatic board check, not a message from a person. The lead has 0 active child task(s); the nudge threshold is 3.",
  "Card: Fix the login redirect",
  "Card id: card-1",
  "State: review",
].join("\n");

describe("boardWakeNoticeKind", () => {
  it("recognises every server-generated board message id", () => {
    expect(boardWakeNoticeKind("ft3:board:wake:12:thread-lead")).toBe("wake");
    expect(boardWakeNoticeKind("ft3:board:mark:thread-lead")).toBe("wake");
    expect(boardWakeNoticeKind("ft3:board:start:card-1")).toBe("wake");
    expect(boardWakeNoticeKind("ft3:board:orphan:card-1:thread-1:2026-11-02")).toBe("wake");
    expect(boardWakeNoticeKind("ft3:board:brief:thread-lead:nonce")).toBe("brief");
    expect(boardWakeNoticeKind("board:idle-nudge:thread-lead:card-1:review:123")).toBe("nudge");
  });

  it("leaves human and unrelated messages alone", () => {
    expect(boardWakeNoticeKind("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(boardWakeNoticeKind("ft3:board:unmark:child:thread-1")).toBeNull();
    expect(boardWakeNoticeKind("board:idle-nudge")).toBeNull();
    expect(boardWakeNoticeKind("ft3:board:wake")).toBeNull();
  });
});

describe("boardWakeNoticeOf", () => {
  it("uses the first event line of a wake as the collapsed detail", () => {
    const notice = boardWakeNoticeOf({ id: "ft3:board:wake:12:thread-lead", text: wakeText });
    expect(notice).toEqual({ kind: "wake", text: wakeText, detail: "Executor finished its turn." });
    expect(boardWakeNoticeLine(notice!)).toBe("⚙ Lead woken: Executor finished its turn.");
  });

  it("falls back to the first line when a wake has no card context block", () => {
    const notice = boardWakeNoticeOf({
      id: "ft3:board:mark:thread-lead",
      text: "This thread was marked a board lead by a human.",
    });
    expect(notice?.detail).toBe("This thread was marked a board lead by a human.");
  });

  it("labels a re-delivered brief without a detail line", () => {
    const notice = boardWakeNoticeOf({
      id: "ft3:board:brief:thread-lead:nonce",
      text: wakeText,
    });
    expect(notice?.detail).toBeNull();
    expect(boardWakeNoticeLine(notice!)).toBe("⚙ Lead brief");
  });

  it("uses the card line of an idle nudge", () => {
    const notice = boardWakeNoticeOf({
      id: "board:idle-nudge:thread-lead:card-1:review:123",
      text: nudgeText,
    });
    expect(notice?.detail).toBe("Fix the login redirect");
    expect(boardWakeNoticeLine(notice!)).toBe("⚙ Lead nudged: Fix the login redirect");
  });

  it("keeps the whole prompt for the expanded body", () => {
    const notice = boardWakeNoticeOf({ id: "ft3:board:wake:12:thread-lead", text: wakeText });
    expect(notice?.text).toBe(wakeText);
  });

  it("returns null for a message a person wrote", () => {
    expect(
      boardWakeNoticeOf({ id: "11111111-1111-4111-8111-111111111111", text: wakeText }),
    ).toBeNull();
  });
});
