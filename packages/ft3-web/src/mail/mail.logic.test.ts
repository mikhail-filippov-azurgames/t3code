import type { MailLetter, MailTask, MailTimelineEntry } from "@t3tools/ft3-mail/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mailDeliveryBadgeVariant,
  mailLetterSenderLabel,
  mailPlanPhaseLabel,
  mailRecipientLabel,
  mailTaskGroups,
  mailTasksUnsupported,
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

describe("mailTaskGroups", () => {
  it("flips the newest-first timelines to chronological order under each task", () => {
    const first = entry({ letter: letter({ letterId: "letter:1", sequence: 1 }) });
    const second = entry({ letter: letter({ letterId: "letter:2", sequence: 2 }) });
    const third = entry({ letter: letter({ letterId: "letter:3", sequence: 3 }) });
    const groups = mailTaskGroups([task], { "task:one": [third, second, first] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.task).toBe(task);
    expect(groups[0]!.entries.map((item) => item.letter.letterId)).toEqual([
      "letter:1",
      "letter:2",
      "letter:3",
    ]);
  });

  it("keeps tasks without letters as empty threads", () => {
    const groups = mailTaskGroups([task], {});
    expect(groups[0]!.entries).toEqual([]);
    expect(groups[0]!.members).toEqual([]);
  });

  it("keeps the member states under their own task", () => {
    const members = [
      { roleId: "implementation", specialization: null, status: "active", launch: "not_started" },
      { roleId: "test", specialization: null, status: "active", launch: "started" },
      { roleId: "review", specialization: "codex", status: "closed", launch: "closed" },
    ] as const;
    const groups = mailTaskGroups(
      [task, { ...task, taskId: "task:other" }],
      {},
      { "task:one": members },
    );
    expect(groups[0]!.members).toEqual(members);
    expect(groups[1]!.members).toEqual([]);
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

describe("mailTasksUnsupported", () => {
  it("recognizes the unknown-method defect of an old server", () => {
    expect(mailTasksUnsupported("Unknown request tag: mail.tasks", null)).toBe(true);
    expect(mailTasksUnsupported(null, null)).toBe(false);
  });

  it("keeps real server errors retryable", () => {
    const typedFailure = { _tag: "OrchestratorMcpFailure", code: "internal", message: "boom" };
    expect(mailTasksUnsupported("boom", typedFailure)).toBe(false);
    expect(mailTasksUnsupported("The environment request failed.", null)).toBe(false);
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
