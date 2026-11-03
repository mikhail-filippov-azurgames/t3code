/**
 * Mail participant launch port: starts a task with `completionWake: "none"`.
 * The live dispatch lives in `apps/server` to avoid a cycle via `OrchestratorMcpService`.
 */
import {
  CommandId,
  ModelSelection,
  type OrchestrationV2DelegatedTaskRole,
} from "@t3tools/contracts";
import { delegatedTaskPrompt } from "@t3tools/ft3-delegation/server";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

import type { MailIsolation } from "./contracts.ts";

export class MailLaunchError extends Schema.TaggedError<MailLaunchError>()("MailLaunchError", {
  reason: Schema.String,
}) {
  override get message() {
    return `The mail participant could not be launched: ${this.reason}`;
  }
}

export interface MailParticipantLaunchInput {
  readonly leadThreadId: string;
  readonly taskTitle: string;
  readonly memberId: string;
  readonly roleId: string;
  readonly modelSelectionJson: string;
  readonly letterBody: string;
  readonly isolation: MailIsolation | null;
}

export class MailParticipantLauncher extends Context.Service<
  MailParticipantLauncher,
  {
    /** Returns the participant thread; the same member launches once, a repeat returns the same thread. */
    readonly launch: (input: MailParticipantLaunchInput) => Effect.Effect<string, MailLaunchError>;
  }
>()("@t3tools/ft3-mail/participantLauncher/MailParticipantLauncher") {}

/** The same member launches once; a repeat reuses the stable launch command. */
export const participantLaunchCommandId = (memberId: string): CommandId =>
  CommandId.make(`mail-participant-launch:${memberId}`);

/** Upstream role names; the routing role `planner` has no upstream counterpart. */
const UPSTREAM_ROLE: Readonly<Record<string, OrchestrationV2DelegatedTaskRole>> = {
  architect: "architecture",
  implementation: "implementation",
  research: "research",
  review: "review",
  test: "test",
  general: "general",
};

/** The upstream delegated role a mail role launches with, if it has one. */
export const participantUpstreamRole = (
  roleId: string,
): OrchestrationV2DelegatedTaskRole | undefined => UPSTREAM_ROLE[roleId];

const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));

/** Reads the stored route back; a corrupt route fails the launch, never the letter. */
export const decodeParticipantModelSelection = (
  modelSelectionJson: string,
): Effect.Effect<ModelSelection, MailLaunchError> =>
  decodeModelSelection(modelSelectionJson).pipe(
    Effect.mapError(
      (cause) =>
        new MailLaunchError({
          reason:
            cause instanceof Error ? cause.message : "the stored route is not a model selection.",
        }),
    ),
  );

/** The participant's first prompt: the applied role line, then the lead's letter. */
export const participantLaunchPrompt = (input: {
  readonly roleLine: string;
  readonly letterBody: string;
}): string =>
  delegatedTaskPrompt({
    roleLine: input.roleLine,
    task: input.letterBody,
    upstreamPrompt: input.letterBody,
  });
