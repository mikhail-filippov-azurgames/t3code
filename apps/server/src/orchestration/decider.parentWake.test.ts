import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("parent-thread");
const projectId = ProjectId.make("project-1");
const turnId = TurnId.make("child-turn");
const wakeMessageId = MessageId.make("delegation-wake:child-turn");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Parent",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: now,
  };
}

const completionPayload = {
  version: 1 as const,
  childThreadId: ThreadId.make("child-thread"),
  delegatedTurnId: turnId,
  status: "completed" as const,
  completedAt: now,
  resultExcerpt: "done",
};

it.layer(NodeServices.layer)("parent wake decider", (it) => {
  it.effect("appends a system wake without starting a parent turn", () =>
    Effect.gen(function* () {
      const planned = yield* decideOrchestrationCommand({
        readModel: makeReadModel(),
        command: {
          type: "thread.message.system.append",
          commandId: CommandId.make("wake-command"),
          threadId,
          message: { messageId: wakeMessageId, text: "Child finished." },
          createdAt: now,
        },
      });
      expect(planned).toMatchObject({
        type: "thread.message-sent",
        payload: { role: "system", messageId: wakeMessageId, turnId: null },
      });
    }),
  );

  it.effect("deduplicates completion activity and wake message by child turn", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({
        activities: [
          {
            id: EventId.make("completion-activity"),
            tone: "info",
            kind: "delegation.completed",
            summary: "Delegated child completed",
            payload: completionPayload,
            turnId: null,
            createdAt: now,
          },
        ],
        messages: [
          {
            id: wakeMessageId,
            role: "system",
            text: "Child finished.",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      const activityResult = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("completion-retry"),
          threadId,
          activity: {
            id: EventId.make("completion-retry-activity"),
            tone: "info",
            kind: "delegation.completed",
            summary: "Delegated child completed",
            payload: completionPayload,
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        },
      });
      expect(activityResult).toEqual([]);

      const messageResult = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.message.system.append",
          commandId: CommandId.make("wake-retry"),
          threadId,
          message: { messageId: wakeMessageId, text: "Child finished." },
          createdAt: now,
        },
      });
      expect(messageResult).toEqual([]);

      readModel = yield* projectEvent(readModel, {
        sequence: 1,
        eventId: EventId.make("unrelated-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("ordinary-message"),
          role: "user",
          text: "ordinary",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(readModel.threads[0]?.messages).toHaveLength(2);
    }),
  );
});
