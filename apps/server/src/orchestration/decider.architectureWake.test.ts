import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  COORDINATOR_ARCHITECT_ACTIVITY_KINDS,
  NEVER_WAKES_SETTLED_THREAD_KINDS,
} from "./coordinatorArchitect.ts";
import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function settledReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: "settled",
        settledAt: NOW,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("architecture markers never wake settled threads", (it) => {
  it.effect("pins every Phase 1 marker kind in the no-wake set", () =>
    Effect.gen(function* () {
      for (const kind of COORDINATOR_ARCHITECT_ACTIVITY_KINDS) {
        expect(NEVER_WAKES_SETTLED_THREAD_KINDS.has(kind)).toBe(true);
      }
      yield* Effect.void;
    }),
  );

  for (const kind of COORDINATOR_ARCHITECT_ACTIVITY_KINDS) {
    it.effect(`appends ${kind} without unsettling`, () =>
      Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.activity.append",
            commandId: CommandId.make(`cmd-activity-${kind}`),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make(`activity-${kind}`),
              tone: "info",
              kind,
              summary: kind,
              payload: { reviewId: "review-1" },
              turnId: null,
              createdAt: NOW,
            } as OrchestrationThread["activities"][number],
            createdAt: NOW,
          },
          readModel: settledReadModel(),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      }),
    );
  }
});
