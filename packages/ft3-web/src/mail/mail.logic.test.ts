import type { MailLetter, MailTask, MailTimelineEntry } from "@t3tools/ft3-mail/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mailDeliveryBadgeVariant,
  mailLetterSenderLabel,
  mailPlanPhaseLabel,
  mailRecipientLabel,
  mailTaskGroup,
} from "./mail.logic.ts";

const task: MailTask = {
  taskId: "task:one",
  title: "Refactor",
  brief: "Split the module.",
  level: "medium",
  cardId: "card-1",
  isolation: null,
  runtimeMode: null,
  interactionMode: null,
  responseBudgetSeconds: 1800,
  status: "open",
  outcome: null,
  summary: null,
  createdByThreadId: "thread:lead",
  clientRequestId: "request:task",
  requestFingerprint: "fingerprint:task",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  closedAt: null,
};

const letter = (overrides: Partial<MailLetter> = {}): MailLetter => ({
  letterId: "letter:one",
  taskId: "task:one",
  sequence: 1,
  senderThreadId: "thread:lead",
  recipient: "role:implementation",
  kind: "request",
  body: "Start.",
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
  requestFingerprint: "fingerprint:letter",
  createdAt: "2026-11-04T00:01:00.000Z",
  ...overrides,
});

const entry = (overrides: Partial<MailTimelineEntry> = {}): MailTimelineEntry => ({
  letter: letter(),
  deliveries: [],
  ...overrides,
});

describe("mailTaskGroup", () => {
  it("flips the newest-first timeline to chronological order", () => {
    const first = entry({ letter: letter({ letterId: "letter:1", sequence: 1 }) });
    const second = entry({ letter: letter({ letterId: "letter:2", sequence: 2 }) });
    const third = entry({ letter: letter({ letterId: "letter:3", sequence: 3 }) });
    const group = mailTaskGroup(task, [third, second, first]);
    expect(group.task).toBe(task);
    expect(group.entries.map((item) => item.letter.letterId)).toEqual([
      "letter:1",
      "letter:2",
      "letter:3",
    ]);
  });

  it("keeps an empty timeline empty", () => {
    expect(mailTaskGroup(task, []).entries).toEqual([]);
  });
});

describe("mailLetterSenderLabel", () => {
  it("names the lead, system and plain participants", () => {
    expect(mailLetterSenderLabel(letter(), task)).toBe("lead");
    expect(mailLetterSenderLabel(letter({ senderThreadId: "system" }), task)).toBe("system");
    expect(mailLetterSenderLabel(letter({ senderThreadId: "thread:worker" }), task)).toBe(
      "participant",
    );
  });
});

describe("mailRecipientLabel", () => {
  it("keeps lead and human readable and unwraps roles", () => {
    expect(mailRecipientLabel("lead")).toBe("lead");
    expect(mailRecipientLabel("human")).toBe("human");
    expect(mailRecipientLabel("role:architect/contracts")).toBe("architect/contracts");
    expect(mailRecipientLabel("member:member-1")).toBe("member");
  });
});

describe("mailPlanPhaseLabel", () => {
  it("shows the phase alone or with its step", () => {
    expect(mailPlanPhaseLabel("draft", null)).toBe("draft");
    expect(mailPlanPhaseLabel("implement", "P2")).toBe("implement P2");
  });
});

describe("mailDeliveryBadgeVariant", () => {
  it("maps every delivery state onto a badge variant", () => {
    expect(mailDeliveryBadgeVariant("pending")).toBe("secondary");
    expect(mailDeliveryBadgeVariant("delivered")).toBe("outline");
    expect(mailDeliveryBadgeVariant("read")).toBe("info");
    expect(mailDeliveryBadgeVariant("answered")).toBe("success");
    expect(mailDeliveryBadgeVariant("failed")).toBe("error");
  });
});
