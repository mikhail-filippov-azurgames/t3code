// @effect-diagnostics-next-line nodeBuiltinImport:off - Session snapshots use bounded native file operations.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Session snapshots use bounded native file operations.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Pi snapshot source names use host path semantics.
import * as NodePath from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import type {
  PiSettings,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
} from "@t3tools/contracts";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { resolveFollowUpAction } from "../FollowUpBehavior.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ensurePiAgentFiles,
  normalizePiModelSlug,
  piModelIdFromSlug,
  piManagedModelsFromConfig,
} from "./piAgentDir.ts";
import {
  isPiExtensionUiDialog,
  isPiToolAllowedWithoutApproval,
  piExtensionUiDeclinedResponse,
} from "./piPermissionBridge.ts";
import {
  ensurePiToolGuardFiles,
  parsePiGuardBlockedNotify,
  parsePiGuardConfirmRecord,
} from "./piToolGuard.ts";
import {
  piTextFromMessageContent,
  piToolCallsFromMessageContent,
  piUsageToCounters,
  readPiTextDelta,
  type PiAssistantMessage,
} from "./piRpcProtocol.ts";
import { resolvePiRuntime } from "./piRuntime.ts";
import {
  makePiSessionRuntime,
  type PiProcessFactory,
  type PiSessionRuntime,
} from "./piSessionRuntime.ts";
import {
  hasPiManagedInferenceConfig,
  makePiInferenceActivity,
  piInferenceSettingsForModel,
  piInferenceServerManager,
  sanitizePiBaseUrlForDisplay,
} from "./piInferenceServer.ts";
import {
  collectPiPersonalInstructions,
  collectPiPersonalSkillSnapshots,
  collectPiProjectSkillSnapshots,
  removeStagedPiProjectSkills,
  stagePiProjectSkillSnapshots,
  type PiProjectSkillSnapshot,
} from "./piResourcePaths.ts";

function piSkillSnapshotName(snapshot: PiProjectSkillSnapshot): string {
  const skillFile = snapshot.files.find((file) => file.relativePath === "SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(
    new TextDecoder().decode(skillFile?.contents ?? new Uint8Array()),
  )?.[1];
  const declared = /^name:\s*(.*?)\s*$/m.exec(frontmatter ?? "")?.[1]?.replace(/^['"]|['"]$/g, "");
  return (
    declared?.trim().toLowerCase() ||
    NodePath.basename(NodePath.dirname(snapshot.sourcePath ?? "skill"))
  );
}

const PROVIDER = ProviderDriverKind.make("pi");
const PI_EXTENSION_UI_TIMEOUT_MS = 50_000;
const PI_EMPTY_OUTPUT_ERROR =
  "Pi returned no assistant output. Check that the selected model is in the Pi catalog and that its inference endpoint is available.";

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly config: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolvePersonalResources?: () => Promise<{
    readonly instructionsPath: string;
    readonly skillsDirectories: ReadonlyArray<string>;
    /** Provenance/partial-coverage diagnostics from default source resolution. */
    readonly warnings?: ReadonlyArray<string> | undefined;
  }>;
  readonly onResourcesLoaded?: (resources: {
    readonly threadId: ThreadId;
    readonly loadedAt: string;
    readonly agents: ReadonlyArray<{
      readonly name: string;
      readonly source: string;
      readonly kind: "personal" | "project";
    }>;
    readonly skills: ReadonlyArray<{
      readonly name: string;
      readonly source: string;
      readonly kind: "personal" | "project";
    }>;
    readonly warnings: ReadonlyArray<string>;
  }) => void;
  /**
   * Test seam: override how the Pi child process is spawned. Production
   * leaves this undefined and uses the real Node spawn.
   */
  readonly runtimeHooks?:
    | {
        readonly processFactory?: PiProcessFactory | undefined;
        /** Test seam for deterministic first-handshake timeout coverage. */
        readonly guardReadyTimeoutMs?: number | undefined;
        readonly inferenceServerManager?: typeof piInferenceServerManager | undefined;
      }
    | undefined;
}

type PiAdapterShape = ProviderAdapterShape<ProviderAdapterError> & {
  readonly emitInferenceActivity: (threadId: ThreadId, message: string) => Effect.Effect<void>;
};

/** Guard verdict for one Pi tool call, tracked for transcript attribution. */
interface PiGuardDecision {
  readonly turnId: TurnId;
  readonly toolName: string;
  readonly decision: "allowed" | "denied";
  readonly reason: string;
}

interface PiPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly extensionRequestId: string;
  readonly method: string;
  readonly requestType: "exec_command_approval" | "file_read_approval" | "file_change_approval";
  readonly deferred: Deferred.Deferred<string>;
  readonly turnId: TurnId | undefined;
  readonly attribution: ReturnType<typeof parsePiGuardConfirmRecord>;
  answered: boolean;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly runtime: PiSessionRuntime;
  readonly model: string | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  /** Turn ids that already streamed `text_delta` (skip `message_end` echo). */
  readonly streamedText: Set<string>;
  /** Turn ids that produced user-visible assistant text or a tool call. */
  readonly outputObserved: Set<string>;
  readonly pendingApprovals: Map<string, PiPendingApproval>;
  /** Guard allow/deny verdicts by Pi tool call id (see `piToolGuard.ts`). */
  readonly guardDecisions: Map<string, PiGuardDecision>;
  /** Turns whose Pi agent_settled should be reported as an FT3 abort. */
  readonly abortingTurnIds: Set<string>;
  /**
   * Turns that already reached a terminal (`turn.completed`/`turn.aborted`).
   * The pump and the interrupt path race on the same `agent_settled`: the
   * atomic check-and-add makes exactly one of them publish the terminal.
   */
  readonly settledTurnIds: Ref.Ref<Set<string>>;
  /** One endpoint permit is held from prompt acceptance through agent_settled. */
  releaseInferenceSlot: (() => void) | undefined;
  inferenceSlotAcquisition: Promise<() => void> | undefined;
}

/** Restart recipe kept after a dead process is evicted. */
interface PiEvictedSession {
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly resumeCursor?: { sessionId: string } | undefined;
}

function approvalDecisionToPiPayload(
  method: string,
  decision: string,
  answers: Record<string, unknown> = {},
): Record<string, unknown> {
  // FT3 Pi tool approvals are deliberately one-shot: acceptForSession and
  // acceptAlways never create a persistent tool grant.
  if (decision !== "accept") {
    return piExtensionUiDeclinedResponse(method);
  }
  if (method === "confirm") return { confirmed: true };
  const answerValue = answers.value ?? answers.text ?? answers.input;
  if (method === "select") {
    return typeof answerValue === "string"
      ? { value: answerValue }
      : piExtensionUiDeclinedResponse(method);
  }
  if (method === "input" || method === "editor") {
    return typeof answerValue === "string"
      ? { value: answerValue }
      : piExtensionUiDeclinedResponse(method);
  }
  return { confirmed: true };
}

function toAdapterError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string" &&
    (cause as { _tag: string })._tag.startsWith("ProviderAdapter")
  ) {
    return cause as ProviderAdapterError;
  }
  return new ProviderAdapterRequestError({
    provider: "pi",
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof Error ? {} : { cause }),
  });
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (options: PiAdapterOptions) {
  const adapterScope = yield* Scope.Scope;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const provideFsPath = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessionsRef = yield* Ref.make(new Map<ThreadId, PiSessionContext>());
  const evictedRef = yield* Ref.make(new Map<ThreadId, PiEvictedSession>());
  const inferenceServerManager =
    options.runtimeHooks?.inferenceServerManager ?? piInferenceServerManager;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => inferenceServerManager.releaseInstance?.(options.instanceId)),
  );

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const publish = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    PubSub.publish(events, event).pipe(Effect.asVoid);

  const stamp = (
    partial: Omit<ProviderRuntimeEvent, "eventId" | "createdAt" | "provider">,
  ): Effect.Effect<ProviderRuntimeEvent> =>
    Effect.gen(function* () {
      return {
        eventId: EventId.make(NodeCrypto.randomUUID()),
        createdAt: yield* nowIso,
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        ...partial,
      } as ProviderRuntimeEvent;
    });

  const emitInferenceActivity = (threadId: ThreadId, message: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* publish(
        yield* stamp({
          type: "runtime.warning",
          threadId,
          payload: { message: `Pi inference server: ${message}` },
        }),
      );
    });

  const inferenceActivity = (threadId: ThreadId, source: "manual" | "automatic") =>
    makePiInferenceActivity({
      instanceId: options.instanceId,
      threadId,
      source,
      emit: (message) => Effect.runPromise(emitInferenceActivity(threadId, message)),
    });

  const releaseInferencePermit = (context: PiSessionContext): void => {
    const release = context.releaseInferenceSlot;
    context.releaseInferenceSlot = undefined;
    release?.();
  };

  const acquireInferencePermit = (
    context: PiSessionContext,
    inferenceSettings: PiSettings,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      if (!hasPiManagedInferenceConfig(inferenceSettings) || context.releaseInferenceSlot) return;
      const pending =
        context.inferenceSlotAcquisition ??
        inferenceServerManager.acquireRequestSlot(inferenceSettings.baseUrl, () => {
          void Effect.runPromise(
            emitInferenceActivity(
              context.threadId,
              "Waiting for the current Pi request; this llama-server is configured with --parallel 1.",
            ),
          );
        });
      context.inferenceSlotAcquisition = pending;
      const release = yield* Effect.tryPromise({
        try: () => pending,
        catch: (cause) => toAdapterError(context.threadId, "inference-queue", cause),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            context.inferenceSlotAcquisition = undefined;
          }),
        ),
      );
      if (context.stopped) {
        release();
        context.inferenceSlotAcquisition = undefined;
        return;
      }
      if (context.releaseInferenceSlot === undefined) context.releaseInferenceSlot = release;
      else if (context.releaseInferenceSlot !== release) release();
      context.inferenceSlotAcquisition = undefined;
    });

  /**
   * Atomically claim the terminal for a turn. The event pump (on
   * `agent_settled`) and the interrupt path (after `abort`) race on the same
   * terminal; only the winner publishes it, the loser stays silent.
   */
  const claimTurnTerminal = (context: PiSessionContext, turnId: TurnId): Effect.Effect<boolean> =>
    Ref.modify(context.settledTurnIds, (settled) =>
      settled.has(turnId)
        ? ([false, settled] as const)
        : ([true, new Set(settled).add(turnId)] as const),
    );

  const finishApproval = (
    context: PiSessionContext,
    pending: PiPendingApproval,
    decision: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (pending.answered) return;
      pending.answered = true;
      const safeDecision = decision === "accept" ? "accept" : "decline";
      if (pending.attribution && pending.turnId) {
        context.guardDecisions.set(pending.attribution.toolCallId, {
          turnId: pending.turnId,
          toolName: pending.attribution.toolName,
          decision: safeDecision === "accept" ? "allowed" : "denied",
          reason:
            safeDecision === "accept"
              ? `Approved via FT3 approval for ${pending.attribution.toolName}.`
              : `Denied via FT3 approval for ${pending.attribution.toolName}.`,
        });
      }
      yield* Deferred.succeed(pending.deferred, safeDecision).pipe(Effect.ignore);
      yield* context.runtime
        .answerExtensionUi(
          pending.extensionRequestId,
          approvalDecisionToPiPayload(pending.method, safeDecision),
        )
        .pipe(Effect.ignore);
      yield* publish(
        yield* stamp({
          type: "request.resolved",
          threadId: context.threadId,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId: pending.requestId,
          payload: {
            requestType: pending.requestType,
            decision: safeDecision,
          },
        }),
      );
    });

  const declinePendingApprovals = (context: PiSessionContext): Effect.Effect<void> =>
    Effect.forEach(
      [...context.pendingApprovals.values()],
      (pending) => finishApproval(context, pending, "decline"),
      { discard: true },
    );

  const getSessionContext = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterError> =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => {
        const context = sessions.get(threadId);
        return context
          ? Effect.succeed(context)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId }));
      }),
    );

  const agentDirForInstance = (): string =>
    path.join(serverConfig.stateDir, "pi", options.instanceId, "agent");

  const ensureAgentDir = (
    agentDir: string,
    guardAgentDir: string,
    runtimeMode: ProviderSessionStartInput["runtimeMode"],
    model: string | undefined,
    workspaceRoot: string,
  ): Effect.Effect<void, ProviderAdapterError> => {
    let inferenceSettings: PiSettings;
    try {
      inferenceSettings = piInferenceSettingsForModel(options.config, model);
    } catch (cause) {
      return Effect.fail(
        new ProviderAdapterProcessError({
          provider: "pi",
          threadId: "unknown",
          detail: `Failed to resolve Pi model profile: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
      );
    }

    return provideFsPath(
      Effect.flatMap(
        ensurePiAgentFiles(agentDir, {
          baseUrl: inferenceSettings.baseUrl,
          apiKey: options.config.apiKey,
          models: piManagedModelsFromConfig({
            configuredModel: options.config.model,
            customModels: options.config.customModels,
          }).concat(piModelIdFromSlug(model) ?? []),
          runtimeMode: runtimeMode as never,
          defaultModel: inferenceSettings.model,
          systemNote: `${buildRuntimeInstructions({ harness: "Pi", model, orchestrationAvailable: true })}\n\nPi runs inside FT3 with tools pinned to ${runtimeMode}; the FT3 tool guard approves or refuses each call before it runs, and extension dialogs auto-decline on timeout.\n`,
        }),
        // The pre-execution guard (tool_call extension + policy) is what
        // enforces the permission envelope; without these files Pi would run
        // every enabled tool unasked.
        () =>
          ensurePiToolGuardFiles(guardAgentDir, {
            runtimeMode: runtimeMode as never,
            workspaceRoot,
          }),
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: "pi",
            threadId: "unknown",
            detail: `Failed to prepare Pi agent dir at ${agentDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      ),
    );
  };

  /**
   * Evict a dead process/session: abort the active turn, decline pending
   * approvals, keep the turn history plus a restart recipe (Pi session id),
   * and close the scope so the pump fibers end. The next `sendTurn`
   * restarts the child and resumes the same Pi session.
   */
  const evictDeadSession = (context: PiSessionContext, reason: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stillPresent = (yield* Ref.get(sessionsRef)).get(context.threadId) === context;
      const turnId = context.activeTurnId;
      context.stopped = true;
      yield* Effect.sync(() => releaseInferencePermit(context));
      context.activeTurnId = undefined;
      if (turnId !== undefined) {
        context.streamedText.delete(turnId);
        context.outputObserved.delete(turnId);
        if (yield* claimTurnTerminal(context, turnId)) {
          yield* publish(
            yield* stamp({
              type: "turn.aborted",
              threadId: context.threadId,
              turnId,
              payload: { reason },
            }),
          );
        }
      }
      yield* declinePendingApprovals(context);
      context.pendingApprovals.clear();
      context.guardDecisions.clear();
      const resumeCursor =
        (context.session.resumeCursor as { sessionId?: string } | undefined)?.sessionId !==
        undefined
          ? (context.session.resumeCursor as { sessionId: string })
          : undefined;
      yield* Ref.update(evictedRef, (evicted) =>
        new Map(evicted).set(context.threadId, {
          turns: context.turns,
          runtimeMode: context.session.runtimeMode,
          cwd: context.session.cwd ?? serverConfig.cwd,
          ...(context.session.model ? { model: context.session.model } : {}),
          ...(resumeCursor ? { resumeCursor } : {}),
        }),
      );
      if (stillPresent) {
        yield* Ref.update(sessionsRef, (sessions) => {
          if (sessions.get(context.threadId) !== context) return sessions;
          const copy = new Map(sessions);
          copy.delete(context.threadId);
          return copy;
        });
      }
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      yield* publish(
        yield* stamp({
          type: "session.exited",
          threadId: context.threadId,
          payload: { reason: `${reason} The next turn restarts and resumes the Pi session.` },
          raw: { source: "pi.rpc", method: "exit", payload: { reason } },
        }),
      );
    });

  const handlePiRecord = (
    context: PiSessionContext,
    value: unknown,
    runtimeMode: string,
    eventTurnId: TurnId | undefined,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      // Runtime tags each session event in stdout order. Do not consult the
      // mutable active id here: a prompt acceptance can already have opened
      // the next FT3 turn while an older `agent_settled` is still queued.
      const turnId = eventTurnId;
      switch (record.type) {
        case "pi_extension_ui_request": {
          if (record.method === "notify" && typeof record.message === "string") {
            const blocked = parsePiGuardBlockedNotify(record.message);
            if (blocked && turnId) {
              context.guardDecisions.set(blocked.toolCallId, {
                turnId,
                toolName: blocked.toolName,
                decision: "denied",
                reason: blocked.reason,
              });
            }
          }
          return;
        }
        case "message_update": {
          // Transcript text comes only from `text_delta`. Thinking deltas,
          // tool-arg deltas, and end snapshots are never emitted as text.
          const delta = readPiTextDelta(record);
          if (delta !== undefined && turnId) {
            if (delta.length > 0) context.outputObserved.add(String(turnId));
            context.streamedText.add(turnId);
            yield* publish(
              yield* stamp({
                type: "content.delta",
                threadId: context.threadId,
                turnId,
                payload: { streamKind: "assistant_text", delta },
                raw: { source: "pi.rpc", method: "message_update", payload: record },
              }),
            );
          }
          return;
        }
        case "message_end": {
          const message = record.message as PiAssistantMessage | undefined;
          if (message?.role === "assistant") {
            // `message_end` is authoritative state, but its text duplicates
            // already-streamed `text_delta`s — emit it only when nothing
            // streamed for this turn (e.g. a non-streaming provider).
            const text = piTextFromMessageContent(message.content);
            const toolCalls = piToolCallsFromMessageContent(message.content);
            if (turnId && (text.length > 0 || toolCalls.length > 0)) {
              context.outputObserved.add(String(turnId));
            }
            if (text.length > 0 && turnId && !context.streamedText.has(turnId)) {
              yield* publish(
                yield* stamp({
                  type: "content.delta",
                  threadId: context.threadId,
                  turnId,
                  payload: { streamKind: "assistant_text", delta: text },
                  raw: { source: "pi.rpc", method: "message_end", payload: record },
                }),
              );
            }
            for (const call of toolCalls) {
              const itemId = RuntimeItemId.make(`pi-tool-${call.id || call.name}`);
              // The guard's verdict is authoritative: it ran before execution
              // and its confirm outcome is tracked per call id. The static
              // envelope below only classifies calls the guard let through
              // without a dialog.
              const verdict = turnId && call.id ? context.guardDecisions.get(call.id) : undefined;
              const decided = verdict && verdict.turnId === turnId ? verdict : undefined;
              if (decided) {
                if (decided.decision === "allowed") {
                  yield* publish(
                    yield* stamp({
                      type: "item.completed",
                      threadId: context.threadId,
                      ...(turnId ? { turnId } : {}),
                      itemId,
                      payload: {
                        itemType: "mcp_tool_call",
                        title: call.name,
                        data: call.args,
                      },
                      raw: { source: "pi.rpc", method: "toolCall", payload: call },
                    }),
                  );
                } else {
                  yield* publish(
                    yield* stamp({
                      type: "tool.denied",
                      threadId: context.threadId,
                      ...(turnId ? { turnId } : {}),
                      itemId,
                      payload: {
                        toolName: call.name,
                        reason: decided.reason,
                      },
                      raw: { source: "pi.rpc", method: "toolCall", payload: call },
                    }),
                  );
                }
                context.guardDecisions.delete(call.id);
                continue;
              }
              const allowed = isPiToolAllowedWithoutApproval(call.name, runtimeMode as never);
              if (!allowed) {
                yield* publish(
                  yield* stamp({
                    type: "tool.denied",
                    threadId: context.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId,
                    payload: {
                      toolName: call.name,
                      reason: `Pi tool ${call.name} ran without the ${runtimeMode} approval it requires; the guard should have held it. Treated as denied.`,
                    },
                    raw: { source: "pi.rpc", method: "toolCall", payload: call },
                  }),
                );
                continue;
              }
              yield* publish(
                yield* stamp({
                  type: "item.completed",
                  threadId: context.threadId,
                  ...(turnId ? { turnId } : {}),
                  itemId,
                  payload: {
                    itemType: "mcp_tool_call",
                    title: call.name,
                    data: call.args,
                  },
                  raw: { source: "pi.rpc", method: "toolCall", payload: call },
                }),
              );
            }
            const counters = piUsageToCounters(message.usage);
            if (counters) {
              yield* publish(
                yield* stamp({
                  type: "thread.token-usage.updated",
                  threadId: context.threadId,
                  ...(turnId ? { turnId } : {}),
                  payload: {
                    usage: {
                      usedTokens: counters.inputTokens + counters.outputTokens,
                      inputTokens: counters.inputTokens,
                      cachedInputTokens: counters.cachedInputTokens,
                      outputTokens: counters.outputTokens,
                      reasoningOutputTokens: counters.reasoningTokens,
                      lastUsedTokens: counters.inputTokens + counters.outputTokens,
                      lastInputTokens: counters.inputTokens,
                      lastCachedInputTokens: counters.cachedInputTokens,
                      lastOutputTokens: counters.outputTokens,
                      lastReasoningOutputTokens: counters.reasoningTokens,
                      compactsAutomatically: true,
                    },
                  },
                  raw: { source: "pi.rpc", method: "message_end", payload: message.usage },
                }),
              );
            }
          }
          return;
        }
        case "agent_settled": {
          yield* Effect.sync(() => releaseInferencePermit(context));
          // A settled event with no active turn is a late terminal for an
          // already aborted/steered turn (or a duplicate): stay silent so a
          // turn never completes twice.
          if (
            turnId &&
            !context.abortingTurnIds.has(String(turnId)) &&
            (yield* claimTurnTerminal(context, turnId))
          ) {
            const outputObserved = context.outputObserved.has(String(turnId));
            yield* publish(
              yield* stamp({
                type: "turn.completed",
                threadId: context.threadId,
                turnId,
                payload: outputObserved
                  ? { state: "completed", outputStatus: "available" }
                  : {
                      state: "failed",
                      outputStatus: "empty",
                      errorMessage: PI_EMPTY_OUTPUT_ERROR,
                    },
                raw: { source: "pi.rpc", method: "agent_settled", payload: record },
              }),
            );
            context.streamedText.delete(turnId);
            context.outputObserved.delete(String(turnId));
            if (context.activeTurnId === turnId) {
              context.activeTurnId = undefined;
              context.session = {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: yield* nowIso,
              };
            }
          }
          return;
        }
        case "pi_stderr": {
          const text = String(record.text ?? "").slice(0, 500);
          if (text.length === 0) return;
          yield* publish(
            yield* stamp({
              type: "runtime.warning",
              threadId: context.threadId,
              ...(turnId ? { turnId } : {}),
              payload: { message: `Pi stderr: ${text}` },
              raw: { source: "pi.rpc", method: "stderr", payload: record },
            }),
          );
          return;
        }
        case "pi_exit": {
          yield* evictDeadSession(context, `Pi process exited (code ${String(record.code)}).`);
          return;
        }
        default:
          return;
      }
    });

  const handleExtensionUi = (
    context: PiSessionContext,
    id: string,
    method: string,
    record: Record<string, unknown>,
    eventTurnId: string | undefined,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!isPiExtensionUiDialog(method)) return;
      // The only approved dialog in this explicitly loaded extension is its
      // structured tool_call confirmation. Other extension dialogs indicate
      // unexpected code and are refused without opening an FT3 prompt.
      const attribution =
        method === "confirm"
          ? parsePiGuardConfirmRecord({ title: record.title, message: record.message })
          : undefined;
      if (!attribution) {
        yield* context.runtime
          .answerExtensionUi(id, piExtensionUiDeclinedResponse(method))
          .pipe(Effect.ignore);
        return;
      }
      const requestId = RuntimeRequestId.make(`pi-${id}`);
      const turnId = eventTurnId ? TurnId.make(eventTurnId) : undefined;
      const requestType =
        attribution.toolName === "bash" || attribution.toolName === "powershell"
          ? "exec_command_approval"
          : attribution.toolName === "read" ||
              attribution.toolName === "grep" ||
              attribution.toolName === "find" ||
              attribution.toolName === "ls"
            ? "file_read_approval"
            : "file_change_approval";
      // Host-side policy check mirrors the immutable FT3 envelope. In
      // particular approval-required is read-only even if a malformed guard
      // dialog somehow asks to run a write.
      if (
        context.session.runtimeMode === "approval-required" &&
        requestType === "file_change_approval"
      ) {
        yield* context.runtime
          .answerExtensionUi(id, piExtensionUiDeclinedResponse(method))
          .pipe(Effect.ignore);
        return;
      }
      const deferred = yield* Deferred.make<string>();
      const pending: PiPendingApproval = {
        requestId,
        extensionRequestId: id,
        method,
        requestType,
        deferred,
        turnId,
        attribution,
        answered: false,
      };
      context.pendingApprovals.set(requestId, pending);
      yield* publish(
        yield* stamp({
          type: "request.opened",
          threadId: context.threadId,
          ...(turnId ? { turnId } : {}),
          requestId,
          payload: {
            requestType,
            detail: attribution.reason,
            args: {
              toolName: attribution.toolName,
              toolCallId: attribution.toolCallId,
              input: attribution.input,
            },
            options: [
              { decision: "accept", label: "Allow once" },
              { decision: "decline", label: "Deny" },
            ],
          },
          raw: { source: "pi.rpc", method: `extension_ui:${method}`, payload: record },
        }),
      );
      try {
        const decision = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(PI_EXTENSION_UI_TIMEOUT_MS),
          Effect.map((option) => (option._tag === "Some" ? option.value : "decline")),
        );
        yield* finishApproval(context, pending, decision);
      } finally {
        if (context.pendingApprovals.get(requestId) === pending) {
          context.pendingApprovals.delete(requestId);
        }
      }
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      const threadId = input.threadId;
      const existing = (yield* Ref.get(sessionsRef)).get(threadId);
      if (existing && !existing.stopped) return existing.session;

      const cwd =
        typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : serverConfig.cwd;
      const projectSkillCollection = yield* Effect.promise(() =>
        collectPiProjectSkillSnapshots(cwd).catch(() => ({ snapshots: [], skippedSkillCount: 0 })),
      );
      const projectSkillSnapshots = projectSkillCollection.snapshots;
      const personalPaths = yield* Effect.tryPromise({
        try: () =>
          options.resolvePersonalResources?.() ??
          Promise.resolve({
            instructionsPath: options.config.personalInstructionsPath ?? "",
            skillsDirectories: options.config.personalSkillsDirectory
              ? [options.config.personalSkillsDirectory]
              : [],
          }),
        catch: (cause) => toAdapterError(threadId, "startSession", cause),
      });
      const personalInstructions = personalPaths.instructionsPath
        ? yield* Effect.tryPromise({
            try: () => collectPiPersonalInstructions(personalPaths.instructionsPath),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: "pi",
                threadId,
                detail: `Personal Pi AGENTS.md: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          })
        : undefined;
      const personalCollections = yield* Effect.forEach(
        personalPaths.skillsDirectories,
        (directory) =>
          Effect.tryPromise({
            try: () => collectPiPersonalSkillSnapshots(directory),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: "pi",
                threadId,
                detail: `Personal Pi skills at ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          }),
      );
      const personalSkills = personalCollections.flatMap((collection) => collection.snapshots);
      const resourceWarnings: Array<string> = [
        ...(personalPaths.warnings ?? []),
        ...personalCollections.flatMap((collection, index) =>
          collection.skippedSkillCount > 0
            ? [
                `Skipped ${collection.skippedSkillCount} unsafe personal Pi skill(s) from ${personalPaths.skillsDirectories[index]}.`,
              ]
            : [],
        ),
      ];
      if (projectSkillCollection.skippedSkillCount > 0) {
        yield* publish(
          yield* stamp({
            type: "runtime.warning",
            threadId,
            payload: {
              message: `Skipped ${projectSkillCollection.skippedSkillCount} Pi project skill(s) because a skill tree contained an unsafe or unstable path, or exceeded the bounded snapshot limits. Each skipped skill was omitted in full.`,
            },
          }),
        );
      }
      const instanceAgentDir = agentDirForInstance();
      const agentDir = path.join(
        instanceAgentDir,
        "sessions",
        NodeCrypto.createHash("sha256").update(String(threadId)).digest("hex"),
        NodeCrypto.randomUUID(),
      );
      // Policy and extension files are per FT3 thread. Multiple sessions for
      // one Pi provider can have different workspaces and runtime modes.
      const guardAgentDir = path.join(agentDir, "guard");
      const requestedModel = normalizePiModelSlug(
        input.modelSelection?.model?.trim() || options.config.model.trim(),
      );
      const scope = yield* Scope.make();
      yield* Scope.addFinalizer(
        scope,
        Effect.promise(() =>
          NodeFSP.rm(agentDir, { recursive: true, force: true }).catch(() => undefined),
        ),
      );
      const cleanupFailedStart = () => Scope.close(scope, Exit.void).pipe(Effect.ignore);
      yield* ensureAgentDir(agentDir, guardAgentDir, input.runtimeMode, requestedModel, cwd).pipe(
        Effect.onError(cleanupFailedStart),
      );
      yield* Effect.tryPromise({
        try: async () => {
          const file = path.join(agentDir, "AGENTS.md");
          if (personalInstructions)
            await NodeFSP.writeFile(file, personalInstructions, { mode: 0o400 });
          else await NodeFSP.rm(file, { force: true });
        },
        catch: (cause) => toAdapterError(threadId, "startSession", cause),
      }).pipe(Effect.onError(cleanupFailedStart));
      const launch = yield* provideFsPath(
        resolvePiRuntime({
          binaryPath: options.config.binaryPath,
          env: options.environment,
        }),
      ).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "startSession", cause)),
        Effect.onError(cleanupFailedStart),
      );

      const seenSkillNames = new Set<string>();
      const allSkillEntries = [
        ...projectSkillSnapshots.map((snapshot) => ({ snapshot, kind: "project" as const })),
        ...personalSkills.map((snapshot) => ({ snapshot, kind: "personal" as const })),
      ].filter(({ snapshot }) => {
        const name = piSkillSnapshotName(snapshot);
        if (seenSkillNames.has(name)) {
          resourceWarnings.push(
            `Skipped duplicate Pi skill ${name} from ${snapshot.sourcePath ?? "unknown source"}.`,
          );
          return false;
        }
        seenSkillNames.add(name);
        return true;
      });
      const allSkillSnapshots = allSkillEntries.map(({ snapshot }) => snapshot);
      const stagedSkills =
        allSkillSnapshots.length > 0
          ? yield* Effect.tryPromise({
              try: () => stagePiProjectSkillSnapshots(allSkillSnapshots, guardAgentDir),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: "pi",
                  threadId,
                  detail: `Failed to stage project skills for Pi: ${cause instanceof Error ? cause.message : String(cause)}`,
                  cause,
                }),
            }).pipe(Effect.onError(cleanupFailedStart))
          : undefined;
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() =>
          inferenceServerManager.releaseActivity(
            options.instanceId,
            threadId,
            options.config.baseUrl,
          ),
        ),
      );
      if (stagedSkills) {
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(() =>
            removeStagedPiProjectSkills(stagedSkills.directory).catch(() => undefined),
          ),
        );
      }
      const loadedResources = yield* Effect.tryPromise({
        try: async () => {
          const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            additionalSkillPaths: [...(stagedSkills?.paths ?? [])],
          });
          await loader.reload({ resolveProjectTrust: async () => false });
          const agents = loader.getAgentsFiles().agentsFiles;
          const skills = loader.getSkills();
          const loadedSkillPaths = new Set(
            skills.skills.map((skill) => path.resolve(skill.filePath)),
          );
          for (const skillPath of stagedSkills?.paths ?? []) {
            if (!loadedSkillPaths.has(path.resolve(skillPath))) {
              throw new Error(
                `Pi native resource loader did not load staged skill ${skillPath}: ${skills.diagnostics.map((item) => item.message).join("; ")}`,
              );
            }
          }
          if (
            personalInstructions &&
            !agents.some((item) => path.resolve(item.path) === path.resolve(agentDir, "AGENTS.md"))
          ) {
            throw new Error("Pi native resource loader did not include personal AGENTS.md.");
          }
          return { agents, skills: skills.skills, diagnostics: skills.diagnostics };
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: "pi",
            threadId,
            detail: `Pi resource validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
      // ProviderInstanceRegistry closes this adapter scope when Pi settings
      // change or the instance is removed. Tie each Pi process to that
      // lifecycle so endpoint claims and staged resources cannot linger until
      // a later RPC happens to poll them.
      yield* Scope.addFinalizer(adapterScope, Scope.close(scope, Exit.void).pipe(Effect.ignore));
      const storedResume = (yield* Ref.get(evictedRef)).get(threadId)?.resumeCursor;
      const resumeCursor =
        (input.resumeCursor as { sessionId?: string } | undefined)?.sessionId !== undefined
          ? (input.resumeCursor as { sessionId: string })
          : storedResume;
      const processFactory = options.runtimeHooks?.processFactory;
      const runtime = yield* makePiSessionRuntime({
        threadId,
        launchCommand: launch.command,
        launchPrefixArgs: launch.prefixArgs,
        launchOrigin: launch.origin,
        runtimeMode: input.runtimeMode,
        cwd,
        env: options.environment,
        agentDir,
        guardExtensionPath: path.join(guardAgentDir, "extensions", "ft3-guard", "index.js"),
        projectSkillPaths: stagedSkills?.paths ?? [],
        ...(options.runtimeHooks?.guardReadyTimeoutMs !== undefined
          ? { guardReadyTimeoutMs: options.runtimeHooks.guardReadyTimeoutMs }
          : {}),
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(resumeCursor?.sessionId ? { sessionId: resumeCursor.sessionId } : {}),
        ...(processFactory ? { processFactory } : {}),
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError((cause) => toAdapterError(threadId, "startSession", cause)),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(scope, exit).pipe(Effect.ignore) : Effect.void,
        ),
      );

      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "connecting",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(requestedModel ? { model: requestedModel } : {}),
        threadId,
        createdAt,
        updatedAt: createdAt,
      };
      const evictedTurns = (yield* Ref.get(evictedRef)).get(threadId)?.turns ?? [];
      const context: PiSessionContext = {
        threadId,
        session,
        scope,
        runtime,
        model: requestedModel,
        turns: [...evictedTurns],
        activeTurnId: undefined,
        stopped: false,
        streamedText: new Set(),
        outputObserved: new Set(),
        pendingApprovals: new Map(),
        guardDecisions: new Map(),
        abortingTurnIds: new Set(),
        settledTurnIds: yield* Ref.make(new Set<string>()),
        releaseInferenceSlot: undefined,
        inferenceSlotAcquisition: undefined,
      };

      // The context joins the live map only after the handshake succeeds. A
      // failed first handshake must not leave a dead-but-"ready" entry: the
      // next `startSession` would return it as usable and never spawn a new
      // child. Instead the recipe below lets the retry rebuild the process.
      const started = yield* runtime.start().pipe(
        Effect.mapError((cause) =>
          toAdapterError(
            threadId,
            "startSession",
            cause instanceof Error
              ? new Error(
                  `${cause.message} (launch ${launch.origin}, base URL ${sanitizePiBaseUrlForDisplay(options.config.baseUrl)}; see packaging/pi-runtime.json)`,
                  { cause },
                )
              : cause,
          ),
        ),
        Effect.onError(() =>
          Effect.gen(function* () {
            const alreadyEvicted = (yield* Ref.get(evictedRef)).has(threadId);
            if (!alreadyEvicted) {
              yield* Ref.update(evictedRef, (evicted) =>
                new Map(evicted).set(threadId, {
                  turns: [],
                  runtimeMode: input.runtimeMode,
                  cwd,
                  ...(requestedModel ? { model: requestedModel } : {}),
                }),
              );
            }
            yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
          }),
        ),
      );
      options.onResourcesLoaded?.({
        threadId,
        loadedAt: yield* nowIso,
        agents: loadedResources.agents.map((agent) => ({
          name: path.basename(agent.path),
          source:
            path.resolve(agent.path) === path.resolve(agentDir, "AGENTS.md")
              ? personalPaths.instructionsPath
              : agent.path,
          kind:
            path.resolve(agent.path) === path.resolve(agentDir, "AGENTS.md")
              ? ("personal" as const)
              : ("project" as const),
        })),
        skills: loadedResources.skills.map((skill) => {
          const index =
            stagedSkills?.paths.findIndex(
              (item) => path.resolve(item) === path.resolve(skill.filePath),
            ) ?? -1;
          const snapshot = allSkillSnapshots[index];
          return {
            name: skill.name,
            source: snapshot?.sourcePath ?? skill.filePath,
            kind: allSkillEntries[index]?.kind ?? "project",
          };
        }),
        warnings: [...resourceWarnings, ...loadedResources.diagnostics.map((item) => item.message)],
      });
      yield* Ref.update(sessionsRef, (sessions) => new Map(sessions).set(threadId, context));
      yield* Ref.update(evictedRef, (evicted) => {
        if (!evicted.has(threadId)) return evicted;
        const copy = new Map(evicted);
        copy.delete(threadId);
        return copy;
      });
      context.session = {
        ...session,
        status: "ready",
        ...(started.sessionId ? { resumeCursor: { sessionId: started.sessionId } } : {}),
        updatedAt: yield* nowIso,
      };
      yield* publish(
        yield* stamp({
          type: "session.started",
          threadId,
          payload: {
            ...(started.sessionId ? { resume: { sessionId: started.sessionId } } : {}),
            message: `Pi harness ready (${launch.origin}; tools pinned to ${input.runtimeMode}).`,
          },
        }),
      );

      yield* Effect.forkIn(scope)(
        Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(context.runtime.events);
            yield* handlePiRecord(
              context,
              event.record,
              input.runtimeMode,
              event.turnId ? TurnId.make(event.turnId) : undefined,
            );
          }
        }).pipe(Effect.ignore),
      );
      yield* Effect.forkIn(scope)(
        Effect.gen(function* () {
          while (true) {
            const call = yield* Queue.take(context.runtime.extensionUiRequests);
            yield* Effect.forkIn(context.scope)(
              Effect.gen(function* () {
                yield* handleExtensionUi(context, call.id, call.method, call.record, call.turnId);
              }).pipe(
                Effect.matchCauseEffect({
                  onFailure: () =>
                    context.runtime
                      .answerExtensionUi(call.id, piExtensionUiDeclinedResponse(call.method))
                      .pipe(Effect.ignore),
                  onSuccess: () => Effect.void,
                }),
              ),
            );
          }
        }).pipe(Effect.ignore),
      );

      return context.session;
    });

  /**
   * Publish `turn.aborted` for a live turn exactly once. Shared by explicit
   * interrupts and steers, which both end the active Pi run first.
   */
  const abortActiveTurn = (
    context: PiSessionContext,
    turnId: TurnId,
    reason: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (context.activeTurnId !== turnId) return;
      context.activeTurnId = undefined;
      context.streamedText.delete(turnId);
      context.outputObserved.delete(String(turnId));
      if (yield* claimTurnTerminal(context, turnId)) {
        yield* publish(
          yield* stamp({
            type: "turn.aborted",
            threadId: context.threadId,
            turnId,
            payload: { reason },
          }),
        );
      }
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
    });

  /** Called from Pi's successful RPC response handler before later stdout records. */
  const activateAcceptedTurn = (context: PiSessionContext, turnId: TurnId): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (!context.turns.some((turn) => turn.id === turnId)) {
        context.turns.push({ id: turnId, items: [] });
      }
      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };
      yield* publish(
        yield* stamp({
          type: "turn.started",
          threadId: context.threadId,
          turnId,
          payload: {},
        }),
      );
      return String(turnId);
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const message = input.input?.trim() ?? "";
      if (message.length === 0 && input.continuation !== true) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: "pi",
            operation: "sendTurn",
            issue: "Pi turns require a non-empty prompt (promptless continuation is unsupported).",
          }),
        );
      }
      let context = yield* getSessionContext(input.threadId).pipe(
        Effect.catchTag("ProviderAdapterSessionNotFoundError", () => Effect.succeed(undefined)),
      );
      if (context === undefined || context.stopped) {
        // Restart after a dead process was evicted (or a stop): rebuild the
        // child from the stored recipe and resume the same Pi session.
        const evicted = (yield* Ref.get(evictedRef)).get(input.threadId);
        if (evicted === undefined) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId: input.threadId }),
          );
        }
        const restarted = yield* startSession({
          threadId: input.threadId,
          cwd: evicted.cwd,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(evicted.resumeCursor ? { resumeCursor: evicted.resumeCursor } : {}),
          runtimeMode: evicted.runtimeMode,
        });
        void restarted;
        context = yield* getSessionContext(input.threadId);
      }
      const text = message.length > 0 ? message : "Continue.";
      // Auto-start is triggered only by an actual sendTurn. startSession is
      // used to create empty chats too, so it deliberately does not launch
      // the inference process.
      const selectedModel = input.modelSelection?.model ?? context.model;
      let inferenceSettings: PiSettings;
      try {
        inferenceSettings = piInferenceSettingsForModel(options.config, selectedModel);
      } catch (cause) {
        return yield* toAdapterError(input.threadId, "inference-server-start", cause);
      }
      if (hasPiManagedInferenceConfig(inferenceSettings)) {
        const inferenceStatus = yield* Effect.tryPromise({
          try: () =>
            inferenceSettings.inferenceServerAutoStart
              ? inferenceServerManager.ensureReady(
                  options.instanceId,
                  inferenceSettings,
                  inferenceActivity(input.threadId, "automatic"),
                )
              : inferenceServerManager.waitForExistingReady(
                  options.instanceId,
                  inferenceSettings,
                  inferenceActivity(input.threadId, "manual"),
                ),
          catch: (cause) => toAdapterError(input.threadId, "inference-server-start", cause),
        });
        if (!inferenceStatus?.ready) {
          return yield* toAdapterError(
            input.threadId,
            "inference-server-start",
            new Error(
              inferenceStatus?.error ??
                "The local inference server is not ready. Start it or enable auto-start in Pi settings.",
            ),
          );
        }
        const expectedModelId = piModelIdFromSlug(inferenceSettings.model);
        if (expectedModelId && !inferenceStatus.modelIds.includes(expectedModelId)) {
          return yield* toAdapterError(
            input.threadId,
            "inference-server-start",
            new Error(
              `The inference endpoint does not serve the selected Pi model (${expectedModelId}); the prompt was not sent.`,
            ),
          );
        }
      }
      // A restart clears the active turn, so a queued follow-up requested
      // against the dead turn degrades to a fresh start below.
      const action = resolveFollowUpAction({
        followUpBehavior: input.followUpBehavior,
        activeTurnId: context.activeTurnId,
        supportsSteer: true,
      });
      if (action.action === "steer") {
        // FT3 steer: end the active run (partial output is preserved in the
        // streamed deltas), then start a new turn with the new message. The
        // aborted run's late `agent_settled` finds no active turn and stays
        // silent, so the old turn keeps exactly one terminal.
        const supersededTurnId = TurnId.make(action.supersededTurnId);
        yield* declinePendingApprovals(context);
        context.abortingTurnIds.add(String(supersededTurnId));
        yield* context.runtime
          .interrupt()
          .pipe(Effect.mapError((cause) => toAdapterError(context.threadId, "interrupt", cause)));
        yield* abortActiveTurn(context, supersededTurnId, "Steered to a new turn.");
        context.abortingTurnIds.delete(String(supersededTurnId));
        yield* acquireInferencePermit(context, inferenceSettings);
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        yield* context.runtime
          .sendPrompt(text, undefined, () => activateAcceptedTurn(context, turnId))
          .pipe(
            Effect.tapError(() => Effect.sync(() => releaseInferencePermit(context))),
            Effect.mapError((cause) => toAdapterError(context.threadId, "prompt", cause)),
          );
        return { threadId: context.threadId, turnId, supersededTurnId };
      }
      if (action.action === "queue" && context.activeTurnId) {
        // The agent is still running: queue behind it with Pi's documented
        // `streamingBehavior`. Sending `prompt` (rather than the standalone
        // `follow_up` command) is idle-safe — if the run settled in the race
        // window, Pi executes immediately instead of parking the message in
        // a queue no run will ever drain. Either way the same `agent_settled`
        // completes the turn, so no new turn is opened: later events keep
        // attributing to the active turn id returned here.
        const fallbackTurnId = TurnId.make(NodeCrypto.randomUUID());
        const sent = yield* context.runtime
          .sendPrompt(text, "followUp", ({ runActive }) => {
            // Pi accepts while active by queueing behind this FT3 turn. If it
            // settled in the meantime, Pi accepts a fresh run; open a new FT3
            // turn before any records from that run are delivered.
            if (runActive && context.activeTurnId) {
              return Effect.succeed(String(context.activeTurnId));
            }
            return activateAcceptedTurn(context, fallbackTurnId);
          })
          .pipe(Effect.mapError((cause) => toAdapterError(context.threadId, "prompt", cause)));
        const turnId = sent.acceptedTurnId ? TurnId.make(sent.acceptedTurnId) : fallbackTurnId;
        return { threadId: context.threadId, turnId };
      }
      // Fresh start (or a queue that outlived its turn): the turn id is
      // assigned only after Pi accepts the prompt, so a rejected prompt
      // leaves no phantom active turn behind. `resumeTurnId` lets a
      // server-restart recovery continue under the caller's original id.
      const turnId = input.resumeTurnId ?? TurnId.make(NodeCrypto.randomUUID());
      yield* acquireInferencePermit(context, inferenceSettings);
      yield* context.runtime
        .sendPrompt(text, undefined, () => activateAcceptedTurn(context, turnId))
        .pipe(
          Effect.tapError(() => Effect.sync(() => releaseInferencePermit(context))),
          Effect.mapError((cause) => toAdapterError(context.threadId, "prompt", cause)),
        );
      return { threadId: context.threadId, turnId };
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* getSessionContext(threadId);
      const turnId = context.activeTurnId;
      yield* declinePendingApprovals(context);
      if (turnId) context.abortingTurnIds.add(String(turnId));
      yield* context.runtime
        .interrupt()
        .pipe(Effect.mapError((cause) => toAdapterError(threadId, "interrupt", cause)));
      if (turnId) {
        yield* abortActiveTurn(context, turnId, "Interrupted.");
        context.abortingTurnIds.delete(String(turnId));
      }
      yield* Effect.sync(() => releaseInferencePermit(context));
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* getSessionContext(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: "pi",
            operation: "respondToRequest",
            issue: `Unknown Pi approval request: ${requestId}`,
          }),
        );
      }
      yield* finishApproval(context, pending, decision);
    });

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
  ) =>
    Effect.gen(function* () {
      const context = yield* getSessionContext(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: "pi",
            operation: "respondToUserInput",
            issue: `Unknown Pi user-input request: ${requestId}`,
          }),
        );
      }
      yield* finishApproval(context, pending, "accept");
    });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      yield* Effect.sync(() =>
        inferenceServerManager.releaseActivity(
          options.instanceId,
          threadId,
          options.config.baseUrl,
        ),
      );
      yield* Ref.update(evictedRef, (next) => {
        if (!next.has(threadId)) return next;
        const copy = new Map(next);
        copy.delete(threadId);
        return copy;
      });
      const sessions = yield* Ref.get(sessionsRef);
      const context = sessions.get(threadId);
      if (!context) return;
      context.stopped = true;
      yield* Effect.sync(() => releaseInferencePermit(context));
      yield* declinePendingApprovals(context);
      yield* context.runtime.close.pipe(Effect.ignore);
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      yield* Ref.update(sessionsRef, (next) => {
        const copy = new Map(next);
        copy.delete(threadId);
        return copy;
      });
      yield* publish(
        yield* stamp({ type: "session.exited", threadId, payload: { reason: "Stopped." } }),
      );
    });

  return {
    provider: PROVIDER,
    emitInferenceActivity,
    capabilities: {
      sessionModelSwitch: "unsupported",
      supportsConversationRollback: false,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () =>
      Ref.get(sessionsRef).pipe(
        Effect.map((sessions) =>
          [...sessions.values()]
            .filter((context) => !context.stopped)
            .map((context) => context.session),
        ),
      ),
    hasSession: (threadId) =>
      Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId))),
    readThread: (threadId) =>
      getSessionContext(threadId).pipe(
        Effect.map((context) => ({ threadId, turns: context.turns })),
        Effect.catchTag("ProviderAdapterSessionNotFoundError", () =>
          Ref.get(evictedRef).pipe(
            Effect.flatMap((evicted) => {
              const record = evicted.get(threadId);
              return record
                ? Effect.succeed({ threadId, turns: record.turns })
                : Effect.fail(
                    new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId }),
                  );
            }),
          ),
        ),
      ),
    rollbackThread: (_threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "pi",
          operation: "rollbackThread",
          issue: "Pi adapter does not support conversation rollback in slice 1.",
        }),
      ),
    stopAll: () =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        for (const context of sessions.values()) {
          context.stopped = true;
          yield* Effect.sync(() => releaseInferencePermit(context));
          yield* context.runtime.close.pipe(Effect.ignore);
          yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        }
        yield* Ref.set(sessionsRef, new Map());
        yield* Ref.set(evictedRef, new Map());
      }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies PiAdapterShape;
});
