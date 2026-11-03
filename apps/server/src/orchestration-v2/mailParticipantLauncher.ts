/**
 * Live `MailParticipantLauncher`: dispatches with `completionWake: "none"`.
 * Stays in `apps/server`: `ft3-mail` must not import `ThreadManagementService`.
 */
import { ThreadId, type OrchestrationV2ThreadLaunchWorkspaceStrategy } from "@t3tools/contracts";
import {
  MailLaunchError,
  MailParticipantLauncher,
  decodeParticipantModelSelection,
  participantLaunchCommandId,
  participantLaunchPrompt,
  participantUpstreamRole,
  type MailParticipantLaunchInput,
} from "@t3tools/ft3-mail/launcher";
import { delegationPermissionDenial, delegationTextDecision } from "@t3tools/ft3-delegation/server";
import { RoleResolver, roleInstructionLine, roleResolverLayer } from "@t3tools/ft3-policies/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { providerConstraints } from "../mcp/providerConstraints.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const fail = (reason: string) => Effect.fail(new MailLaunchError({ reason }));

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "the orchestrator refused the command.";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const roles = yield* RoleResolver;
  const projects = yield* ProjectService.ProjectService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;

  const launch = Effect.fn("MailParticipantLauncher.launch")(function* (
    input: MailParticipantLaunchInput,
  ) {
    const modelSelection = yield* decodeParticipantModelSelection(input.modelSelectionJson);
    const parent = yield* threads
      .getThreadRecords(ThreadId.make(input.leadThreadId), ["runs"])
      .pipe(Effect.mapError((cause) => new MailLaunchError({ reason: describe(cause) })));
    const parentRun = parent.runs
      .filter(ThreadManagement.isActiveRun)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (parentRun === undefined || parentRun.rootNodeId === null) {
      return yield* fail("the lead has no active run to launch from.");
    }
    const text = delegationTextDecision({ task: input.letterBody, title: input.taskTitle });
    if (text._tag === "Denied") return yield* fail(text.reason);

    const assignment = yield* roles.assignment(input.roleId);
    const roleLine = assignment._tag === "assigned" ? roleInstructionLine(assignment.resolved) : "";
    const prompt = participantLaunchPrompt({ roleLine, letterBody: input.letterBody });

    const liveProviders = yield* providers.getProviders;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new MailLaunchError({ reason: describe(cause) })),
    );
    const denial = delegationPermissionDenial({
      settings,
      providers: liveProviders,
      parentThread: parent.thread,
      targetInstanceId: modelSelection.instanceId,
      runtimeMode: parent.thread.runtimeMode,
      interactionMode: parent.thread.interactionMode,
    });
    if (denial !== undefined) return yield* fail(denial.reason);

    // The stored route was chosen against an older catalog; the live provider still offers it.
    // The V2 adapter itself is re-verified by dispatch; the flag only skips that one message here.
    const provider = liveProviders.find(
      (candidate) => candidate.instanceId === modelSelection.instanceId,
    );
    const constraints = providerConstraints(provider, true);
    if (constraints.length > 0) {
      return yield* fail(
        `Provider ${modelSelection.instanceId} cannot run the participant: ${constraints.join(" ")}`,
      );
    }
    if (
      provider !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === modelSelection.model)
    ) {
      return yield* fail(
        `Model ${modelSelection.model} is not offered by provider ${modelSelection.instanceId}.`,
      );
    }

    let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
    if (input.isolation === "worktree") {
      const project = yield* projects.getById(parent.thread.projectId).pipe(
        Effect.mapError(
          (cause) => new MailLaunchError({ reason: `Unable to read a project: ${cause.message}.` }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => fail(`Project ${parent.thread.projectId} was not found.`),
            onSome: (found) => Effect.succeed(found),
          }),
        ),
      );
      const base = yield* gitDriver
        .resolveCommit({
          cwd: parent.thread.worktreePath ?? project.workspaceRoot,
          revision: "HEAD",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MailLaunchError({
                reason: `Unable to resolve the parent checkout commit: ${describe(cause)}.`,
              }),
          ),
        );
      if (parent.thread.worktreePath !== null) {
        const inside = yield* gitDriver
          .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
          .pipe(Effect.option);
        if (Option.isNone(inside)) {
          return yield* fail(
            `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit.`,
          );
        }
      }
      workspaceStrategy = { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
    }

    const upstreamRole = participantUpstreamRole(input.roleId);
    const result = yield* threads
      .dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: participantLaunchCommandId(input.memberId),
        parentThreadId: parent.thread.id,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        task: prompt,
        ...(upstreamRole === undefined ? {} : { role: upstreamRole }),
        title: input.taskTitle,
        modelSelection,
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
        ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        // The participant answers by letter; it never wakes the lead.
        completionWake: "none",
      })
      .pipe(Effect.mapError((cause) => new MailLaunchError({ reason: describe(cause) })));
    const taskEvent = result.storedEvents.find(
      (stored) =>
        stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
    );
    if (
      taskEvent?.event.type !== "subagent.updated" ||
      taskEvent.event.payload.childThreadId === null
    ) {
      return yield* fail("the orchestrator did not start a participant thread.");
    }
    const childThreadId = taskEvent.event.payload.childThreadId;
    const childRunEvent = result.storedEvents.find(
      (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
    );
    if (
      childRunEvent?.event.type === "run.created" &&
      childRunEvent.event.payload.workspacePreparation !== undefined
    ) {
      yield* threadLaunch
        .prepareRun({
          commandId: participantLaunchCommandId(input.memberId),
          threadId: childThreadId,
          runId: childRunEvent.event.payload.id,
        })
        .pipe(Effect.mapError((cause) => new MailLaunchError({ reason: describe(cause) })));
    }
    return childThreadId;
  });

  return MailParticipantLauncher.of({ launch });
});

export const layer = Layer.effect(MailParticipantLauncher, make).pipe(
  Layer.provide(roleResolverLayer),
);
