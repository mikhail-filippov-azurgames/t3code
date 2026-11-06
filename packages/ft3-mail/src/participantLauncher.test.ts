import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeParticipantModelSelection,
  participantLaunchCommandId,
  participantLaunchPrompt,
  participantReplyLine,
  participantThreadTitle,
  participantUpstreamRole,
} from "./participantLauncher.ts";

it.effect("maps a mail role to its upstream delegated role", () =>
  Effect.sync(() => {
    assert.equal(participantUpstreamRole("implementation"), "implementation");
    assert.equal(participantUpstreamRole("architect"), "architecture");
    assert.equal(participantUpstreamRole("planner"), "planner");
  }),
);

it.effect("keeps one stable command id per member", () =>
  Effect.sync(() => {
    assert.equal(
      participantLaunchCommandId("member:one"),
      participantLaunchCommandId("member:one"),
    );
  }),
);

it.effect("builds the participant prompt from the role line and the letter", () =>
  Effect.sync(() => {
    const prompt = participantLaunchPrompt({
      roleLine: "You implement.",
      letterBody: "Build it.",
      taskId: "task:one",
      letterId: "letter:one",
    });
    assert.include(prompt, "You implement.");
    assert.include(prompt, "Build it.");
    assert.include(
      prompt,
      'Reply with mail_send: taskId "task:one", to "lead", kind "answer", replyToLetterId "letter:one"',
    );
  }),
);

it.effect("keeps the reply line past the parsed header shape", () =>
  Effect.sync(() => {
    const line = participantReplyLine({ taskId: "task:one", letterId: "letter:one" });
    assert.isFalse(line.includes("\n\n"));
    assert.include(line, 'taskId "task:one"');
    assert.include(line, 'to "lead"');
    assert.include(line, 'replyToLetterId "letter:one"');
  }),
);

it.effect("titles the participant thread with the role and specialization", () =>
  Effect.sync(() => {
    assert.equal(
      participantThreadTitle({
        roleId: "review",
        specialization: "contracts",
        taskTitle: "Review: mail_task_create cardId",
      }),
      "review/contracts: Review: mail_task_create cardId",
    );
  }),
);

it.effect("titles the participant thread with the bare role when there is no specialization", () =>
  Effect.sync(() => {
    assert.equal(
      participantThreadTitle({
        roleId: "implementation",
        specialization: null,
        taskTitle: "Fix the bug",
      }),
      "implementation: Fix the bug",
    );
  }),
);

it.effect("decodes the stored route and refuses a corrupt one", () =>
  Effect.gen(function* () {
    const selection = yield* decodeParticipantModelSelection(
      JSON.stringify({ instanceId: "codex", model: "gpt-test" }),
    );
    assert.equal(selection.model, "gpt-test");

    const failure = yield* decodeParticipantModelSelection("not json").pipe(Effect.flip);
    assert.equal(failure._tag, "MailLaunchError");
  }),
);
