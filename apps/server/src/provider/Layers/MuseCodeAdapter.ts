/**
 * MuseCodeAdapter — MSP session/turn/approval runtime as a ProviderAdapter.
 *
 * One shared `muse serve` host per adapter instance; SDK sessions multiplex
 * on it. Turn text streams from the turn handle's deltas, approvals park on
 * per-request Deferreds resolved by `respondToRequest`. Anything the
 * 0.1.1 facade cannot observe (live user-input prompts, thread rewind)
 * fails with an explicit unsupported error instead of a fabricated event.
 *
 * @module provider/Layers/MuseCodeAdapter
 */
import {
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ApprovalDecisionInput, Session, Turn, TurnOutcome } from "@muse-code/sdk";
import type { ApprovalRequestParams } from "@muse-code/sdk/dist/src/msp.js";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { spawnMuseHost, type MuseHost } from "../muse/MuseMspRuntime.ts";
import type { MuseCodeAdapterShape } from "../Services/MuseCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("museCode");
const MUSE_RESUME_VERSION = 1 as const;
const RAW_SOURCE = "muse.msp.notification" as const;

interface MuseSessionRecord {
  readonly session: Session;
  readonly mspSessionId: string;
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly effort: MuseReasoningEffort | undefined;
  readonly createdAt: string;
  readonly turnIds: Array<string>;
  activeTurnId: string | undefined;
}

const invalidEffortError = (raw: string) =>
  new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation: "sendTurn",
    issue: `Unsupported Muse reasoning effort: '${raw}'.`,
  });

interface PendingMuseApproval {
  readonly decision: Deferred.Deferred<ApprovalDecisionInput>;
  readonly threadId: ThreadId;
  readonly turnId: string | undefined;
  readonly request: ApprovalRequestParams;
}

export interface MuseCodeAdapterOptions {
  readonly museBin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mspErrorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Map a T3 approval decision onto an offered MSP choice id. */
export function museChoiceForDecision(
  decision: ProviderApprovalDecision,
  choices: ReadonlyArray<{
    readonly choiceId: string;
    readonly decision: string;
    readonly scope: string;
  }>,
): string | undefined {
  const first = (predicate: (choice: (typeof choices)[number]) => boolean) =>
    choices.find(predicate)?.choiceId;
  switch (decision) {
    case "accept":
      return (
        first((choice) => choice.decision === "approved") ??
        first((choice) => choice.decision === "approvedForSession")
      );
    case "acceptForSession":
      return (
        first((choice) => choice.decision === "approvedForSession") ??
        first((choice) => choice.decision === "approved")
      );
    case "acceptAlways":
      return (
        first(
          (choice) => choice.scope === "localPersistent" && choice.decision.startsWith("approved"),
        ) ?? first((choice) => choice.decision === "approved")
      );
    case "decline":
      return first((choice) => choice.decision.startsWith("denied"));
    case "cancel":
      return (
        first((choice) => choice.decision === "abort") ??
        first((choice) => choice.decision.startsWith("denied"))
      );
  }
}

function turnStateFromTerminal(
  terminal: string,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (terminal) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    default:
      return "failed";
  }
}

/** Reasoning tiers offered in the model capabilities and sent per turn. */
export const MUSE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type MuseReasoningEffort = (typeof MUSE_REASONING_EFFORTS)[number];

/** Read the selected tier; unknown values stay undefined for explicit rejection. */
export function parseMuseEffort(raw: string | undefined): MuseReasoningEffort | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return (MUSE_REASONING_EFFORTS as ReadonlyArray<string>).includes(raw)
    ? (raw as MuseReasoningEffort)
    : undefined;
}

export function museEffortForSelection(selection: ModelSelection | undefined): {
  readonly raw: string | undefined;
  readonly effort: MuseReasoningEffort | undefined;
} {
  const raw =
    selection === undefined
      ? undefined
      : getModelSelectionStringOptionValue(selection, "reasoningEffort");
  return { raw, effort: parseMuseEffort(raw) };
}

function streamKindFromDeltaField(
  field: string | undefined,
): "assistant_text" | "reasoning_text" | "unknown" {
  if (field === undefined || field === "text" || field === "output") {
    return "assistant_text";
  }
  return field.includes("reason") ? "reasoning_text" : "unknown";
}

export function makeMuseCodeAdapter(options: MuseCodeAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("museCode");
    const crypto = yield* Crypto.Crypto;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const sessionsRef = yield* Ref.make(new Map<ThreadId, MuseSessionRecord>());
    const approvalsRef = yield* Ref.make(new Map<string, PendingMuseApproval>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "msp/runtimeId",
            detail: "Failed to generate Muse runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const host: MuseHost = yield* Effect.acquireRelease(
      spawnMuseHost({ museBin: options.museBin, env: options.env }),
      (live) => Effect.promise(() => live.close()).pipe(Effect.ignore),
    );

    const requireSession = (threadId: ThreadId) =>
      Effect.flatMap(Ref.get(sessionsRef), (sessions) => {
        const record = sessions.get(threadId);
        return record === undefined
          ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
          : Effect.succeed(record);
      });

    const registerApprovalHandler = (record: MuseSessionRecord) => {
      record.session.onApproval((request: ApprovalRequestParams) =>
        runPromise(
          Effect.gen(function* () {
            const gate = yield* Deferred.make<ApprovalDecisionInput>();
            yield* Ref.update(approvalsRef, (pending) =>
              new Map(pending).set(request.approvalId, {
                decision: gate,
                threadId: record.threadId,
                turnId: request.turnId,
                request,
              }),
            );
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "request.opened",
              ...stamp,
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: record.threadId,
              turnId: TurnId.make(request.turnId),
              requestId: RuntimeRequestId.make(request.approvalId),
              payload: {
                requestType: "dynamic_tool_call",
                detail: request.toolName,
                args: {
                  approvalId: request.approvalId,
                  toolCallId: request.toolCallId,
                  rawArgs: request.rawArgs,
                },
              },
              raw: { source: RAW_SOURCE, method: "approval/requested", payload: request },
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to publish Muse approval request.", { cause }),
              ),
            );
            return yield* Deferred.await(gate);
          }),
        ),
      );
    };

    const pumpTurn = (
      record: MuseSessionRecord,
      turn: Turn,
      turnId: TurnId,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: record.threadId,
          turnId,
          payload: {},
          raw: { source: RAW_SOURCE, method: "turn/started", payload: { turnId: turn.turnId } },
        });
        yield* Stream.fromAsyncIterable(
          turn.deltas(),
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "item/delta",
              detail: mspErrorText(cause),
              ...(cause instanceof Error ? { cause } : {}),
            }),
        ).pipe(
          Stream.runForEach((delta) =>
            Effect.gen(function* () {
              const deltaStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...deltaStamp,
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: record.threadId,
                turnId,
                payload: {
                  streamKind: streamKindFromDeltaField(delta.field),
                  delta: delta.delta,
                },
                raw: { source: RAW_SOURCE, method: "item/delta", payload: delta },
              });
            }),
          ),
        );
        const outcome: TurnOutcome = yield* Effect.promise(() => turn.completed).pipe(
          Effect.catchCause(() => Effect.succeed({ kind: "terminalUnknown" } as TurnOutcome)),
        );
        const completedStamp = yield* makeEventStamp();
        if (outcome.kind === "completed") {
          const state = turnStateFromTerminal(outcome.params.terminal);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...completedStamp,
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: record.threadId,
            turnId,
            payload: {
              state,
              ...(outcome.params.reason ? { stopReason: outcome.params.reason } : {}),
              ...(state === "failed" && outcome.params.error
                ? { errorMessage: mspErrorText(outcome.params.error) }
                : {}),
            },
            raw: { source: RAW_SOURCE, method: "turn/completed", payload: outcome.params },
          });
        } else {
          yield* offerRuntimeEvent({
            type: "turn.aborted",
            ...completedStamp,
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: record.threadId,
            turnId,
            payload: {
              reason:
                outcome.kind === "unqueued" ? "Turn unqueued by the host." : "Host died mid-turn.",
            },
            raw: { source: RAW_SOURCE, method: "turn/aborted", payload: { kind: outcome.kind } },
          });
        }
        yield* Ref.update(sessionsRef, (sessions) => {
          const current = sessions.get(record.threadId);
          if (current === undefined) {
            return sessions;
          }
          const next = new Map(sessions);
          next.set(record.threadId, {
            ...current,
            activeTurnId: current.activeTurnId === turn.turnId ? undefined : current.activeTurnId,
          });
          return next;
        });
      }).pipe(Effect.ignore);

    const startSession: MuseCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const resumeSessionId =
          isRecord(input.resumeCursor) && typeof input.resumeCursor.sessionId === "string"
            ? input.resumeCursor.sessionId
            : undefined;
        const selected = museEffortForSelection(input.modelSelection);
        if (selected.raw !== undefined && selected.effort === undefined) {
          return yield* invalidEffortError(selected.raw);
        }
        const session = yield* Effect.tryPromise({
          try: () =>
            resumeSessionId !== undefined
              ? host.client.resumeSession({ sessionId: resumeSessionId })
              : host.client.startSession({
                  ...(input.cwd ? { workspaceRoot: input.cwd } : {}),
                  ...(input.modelSelection ? { modelId: input.modelSelection.model } : {}),
                  ...(selected.effort ? { effort: selected.effort } : {}),
                }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: resumeSessionId !== undefined ? "session/resume" : "session/start",
              detail: mspErrorText(cause),
              ...(cause instanceof Error ? { cause } : {}),
            }),
        });
        const now = yield* nowIso;
        const record: MuseSessionRecord = {
          session,
          mspSessionId: session.sessionId,
          threadId: input.threadId,
          cwd: input.cwd,
          model: input.modelSelection?.model,
          effort: selected.effort,
          createdAt: now,
          turnIds: [],
          activeTurnId: undefined,
        };
        registerApprovalHandler(record);
        yield* Ref.update(sessionsRef, (sessions) => new Map(sessions).set(input.threadId, record));
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload:
            resumeSessionId !== undefined ? { resume: { sessionId: session.sessionId } } : {},
          raw: {
            source: RAW_SOURCE,
            method: "session/start",
            payload: { sessionId: session.sessionId },
          },
        });
        return {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(record.model ? { model: record.model } : {}),
          threadId: input.threadId,
          resumeCursor: { schemaVersion: MUSE_RESUME_VERSION, sessionId: session.sessionId },
          createdAt: now,
          updatedAt: now,
        } satisfies ProviderSession;
      });

    const sendTurn: MuseCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const record = yield* requireSession(input.threadId);
        const prompt = input.input?.trim() || undefined;
        if (prompt === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Muse turns require an explicit prompt; promptless continuation is unsupported.",
          });
        }
        const turnSelected = museEffortForSelection(input.modelSelection);
        if (turnSelected.raw !== undefined && turnSelected.effort === undefined) {
          return yield* invalidEffortError(turnSelected.raw);
        }
        const effort = turnSelected.effort ?? record.effort;
        const turn = yield* Effect.tryPromise({
          try: () =>
            record.session.sendUserTurn({
              input: [{ type: "text", text: prompt }],
              displayText: prompt,
              ...(effort === undefined ? {} : { reasoningEffort: effort }),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: mspErrorText(cause),
              ...(cause instanceof Error ? { cause } : {}),
            }),
        });
        const turnId = TurnId.make(turn.turnId);
        yield* Ref.update(sessionsRef, (sessions) => {
          const current = sessions.get(input.threadId);
          if (current === undefined) {
            return sessions;
          }
          const next = new Map(sessions);
          next.set(input.threadId, {
            ...current,
            turnIds: [...current.turnIds, turn.turnId],
            activeTurnId: turn.turnId,
          });
          return next;
        });
        yield* Effect.forkDetach(pumpTurn(record, turn, turnId));
        const result: ProviderTurnStartResult = { threadId: input.threadId, turnId };
        return result;
      });

    const interruptTurn: MuseCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const record = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () =>
            host.connection.command("turn/interrupt", {
              sessionId: record.mspSessionId,
              ...(turnId ? { turnId } : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: mspErrorText(cause),
              ...(cause instanceof Error ? { cause } : {}),
            }),
        });
      });

    const respondToRequest: MuseCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const pending = (yield* Ref.get(approvalsRef)).get(String(requestId));
        if (pending === undefined || pending.threadId !== threadId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending Muse approval request: ${requestId}`,
          });
        }
        const choiceId = museChoiceForDecision(decision, pending.request.availableChoices);
        if (choiceId === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `Decision '${decision}' matches no offered Muse choice.`,
          });
        }
        yield* Ref.update(approvalsRef, (entries) => {
          const next = new Map(entries);
          next.delete(String(requestId));
          return next;
        });
        yield* Deferred.succeed(pending.decision, { choiceId });
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: pending.threadId,
          turnId: TurnId.make(pending.request.turnId),
          requestId: RuntimeRequestId.make(String(requestId)),
          payload: { requestType: "dynamic_tool_call", decision },
          raw: { source: RAW_SOURCE, method: "approval/decide", payload: { choiceId } },
        });
      });

    const respondToUserInput: MuseCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const record = yield* requireSession(threadId);
        const mapped: Array<{
          readonly questionId: string;
          readonly freeText?: string;
          readonly selectedLabels?: ReadonlyArray<string>;
        }> = [];
        for (const [questionId, value] of Object.entries(answers)) {
          if (typeof value === "string") {
            mapped.push({ questionId, freeText: value.slice(0, 500) });
          } else if (
            Array.isArray(value) &&
            value.every((entry): entry is string => typeof entry === "string")
          ) {
            mapped.push({ questionId, selectedLabels: value });
          } else {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue:
                "Muse user-input answers accept strings (free text) or string arrays (multi-select) only.",
            });
          }
        }
        yield* Effect.tryPromise({
          try: () =>
            host.connection.command("userInput/answer", {
              sessionId: record.mspSessionId,
              userInputId: String(requestId),
              answers: mapped,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "userInput/answer",
              detail: mspErrorText(cause),
              ...(cause instanceof Error ? { cause } : {}),
            }),
        });
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: record.threadId,
          requestId: RuntimeRequestId.make(String(requestId)),
          payload: { answers },
          raw: {
            source: RAW_SOURCE,
            method: "userInput/answer",
            payload: { userInputId: requestId },
          },
        });
      });

    const stopSession: MuseCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* requireSession(threadId);
        yield* Ref.update(sessionsRef, (sessions) => {
          const next = new Map(sessions);
          next.delete(threadId);
          return next;
        });
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload: { exitKind: "graceful" },
          raw: {
            source: RAW_SOURCE,
            method: "session/stop",
            payload: { sessionId: record.mspSessionId },
          },
        });
      });

    const listSessions: MuseCodeAdapterShape["listSessions"] = () =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const sessions = yield* Ref.get(sessionsRef);
        return [...sessions.values()].map((record): ProviderSession => ({
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: record.activeTurnId === undefined ? "ready" : "running",
          runtimeMode: "approval-required",
          ...(record.cwd ? { cwd: record.cwd } : {}),
          ...(record.model ? { model: record.model } : {}),
          threadId: record.threadId,
          ...(record.activeTurnId ? { activeTurnId: TurnId.make(record.activeTurnId) } : {}),
          createdAt: record.createdAt,
          updatedAt: now,
        }));
      });

    const hasSession: MuseCodeAdapterShape["hasSession"] = (threadId) =>
      Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId)));

    const readThread: MuseCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* requireSession(threadId);
        return {
          threadId,
          turns: record.turnIds.map((id) => ({ id: TurnId.make(id), items: [] })),
        };
      });

    const rollbackThread: MuseCodeAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `Conversation rollback is unsupported for thread '${threadId}'.`,
        }),
      );

    const stopAll: MuseCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        for (const threadId of sessions.keys()) {
          yield* stopSession(threadId);
        }
      });

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies MuseCodeAdapterShape;
  });
}
