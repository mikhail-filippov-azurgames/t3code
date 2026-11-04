import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeParticipantModelSelection,
  participantLaunchCommandId,
  participantLaunchPrompt,
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
    });
    assert.include(prompt, "You implement.");
    assert.include(prompt, "Build it.");
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
