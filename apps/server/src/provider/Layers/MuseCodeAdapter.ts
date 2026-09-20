/**
 * MuseCodeAdapter — MSP session/turn/approval runtime as a ProviderAdapter.
 *
 * Two shared `muse serve` hosts per adapter instance: the default posture
 * and a sandbox-disabled trusted-workspace host for full-access sessions.
 * Threads with an orchestration-capable MCP credential additionally get a
 * dedicated host with a scoped t3-code MCP config, since the credential is
 * per-thread but a host reads a single settings file. Sandbox and trust are
 * fixed for a host's lifetime, so sessions route by mode while the approval
 * mode itself travels over the wire. Anything the 0.1.1 facade cannot
 * observe (live user-input prompts, thread rewind) fails with an explicit
 * unsupported error instead of a fabricated event.
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
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ApprovalDecisionInput, Session, Turn, TurnOutcome } from "@muse-code/sdk";
import type { ApprovalMode, ApprovalRequestParams, TodoItem } from "@muse-code/sdk/dist/src/msp.js";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  MUSE_FULL_ACCESS_SERVE_ARGS,
  museScopedMcpSettingsDocument,
  resolveMuseConfigDir,
  spawnMuseHost,
  type MuseHost,
} from "../muse/MuseMspRuntime.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { MuseCodeAdapterShape } from "../Services/MuseCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("museCode");
const MUSE_RESUME_VERSION = 1 as const;
const RAW_SOURCE = "muse.msp.notification" as const;

/**
 * How long a Muse turn may run without a delta before the adapter stops
 * trusting the host and settles the turn itself. The SDK never times a turn
 * out locally (facade/turn-handle.js, INV-006), and the reaper skips sessions
 * with an active turn (ProviderSessionReaper), so a host that goes silent
 * mid-turn would leave the thread "thinking" forever. Ten minutes mirrors the
 * Grok reasoning ceiling: Muse streams reasoning deltas, so a healthy turn is
 * not silent that long.
 */
export const MUSE_TURN_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

interface MuseSessionRecord {
  readonly session: Session;
  readonly host: MuseHost;
  readonly mspSessionId: string;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode | undefined;
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
  /** Raw MSP notification log. Owned by the caller; diagnostics only. */
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mspErrorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  // Wire/command rejections can carry plain-object payloads; String() would
  // blind us with "[object Object]", so render the payload instead.
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
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

/** Map a T3 thread runtime mode onto an MSP session approval mode. */
export function museApprovalModeForRuntimeMode(
  mode: RuntimeMode | undefined,
): ApprovalMode | undefined {
  switch (mode) {
    case "full-access":
      return "allowAll";
    case "auto":
    case "auto-accept-edits":
      return "promptUnmatched";
    case "approval-required":
      return "onRequest";
    default:
      return undefined;
  }
}

/** Full-access sessions need the elevated host: sandbox and workspace trust
 * are fixed at `muse serve` spawn and are not negotiable over the wire. */
export function museNeedsElevatedHost(mode: RuntimeMode | undefined): boolean {
  return museApprovalModeForRuntimeMode(mode) === "allowAll";
}

export interface MusePlanStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

/** Map an MSP todo snapshot onto plan steps for turn.plan.updated. Cancelled
 * todos are done, not pending: they must not linger as unfinished work. */
export function musePlanStepsFromTodos(items: ReadonlyArray<TodoItem>): Array<MusePlanStep> {
  const steps: Array<MusePlanStep> = [];
  for (const item of items) {
    const raw =
      item.status === "inProgress" && item.activeForm?.trim() ? item.activeForm : item.text;
    const step = raw?.trim();
    if (!step) continue;
    steps.push({
      step,
      status:
        item.status === "inProgress"
          ? "inProgress"
          : item.status === "completed" || item.status === "cancelled"
            ? "completed"
            : "pending",
    });
  }
  return steps;
}

export interface MuseItemLifecycle {
  readonly itemType: "dynamic_tool_call" | "command_execution";
  readonly status: "inProgress" | "completed" | "failed";
  readonly title: string;
  readonly detail?: string;
}

/** Tool output deltas are already covered by the item card's detail, so they
 * must not also stream into chat text. Anything else keeps flowing. */
export function shouldFoldDelta(field: string | undefined, hasCard: boolean): boolean {
  return hasCard && field === "output";
}

/** Map an MSP toolCall/userShell item onto the shared item lifecycle the
 * client folds into tool cards. reasoning/agentMessage stay chat text. */
export function museItemLifecycle(
  item: {
    readonly kind: string;
    readonly tool?: string | undefined;
    readonly commandText?: string | undefined;
    readonly visibleOutput?: string | undefined;
    readonly status?: string | undefined;
  },
  lifecycle: "item.started" | "item.completed",
): MuseItemLifecycle | undefined {
  const terminalStatus = item.status === "failed" ? "failed" : "completed";
  if (item.kind === "toolCall" && item.tool?.trim()) {
    const title = item.tool.trim();
    if (lifecycle === "item.started") {
      return { itemType: "dynamic_tool_call", status: "inProgress", title };
    }
    const output = item.visibleOutput?.trim();
    return {
      itemType: "dynamic_tool_call",
      status: terminalStatus,
      title,
      ...(output ? { detail: output } : {}),
    };
  }
  if (item.kind === "userShell") {
    const command = item.commandText?.trim();
    const output = item.visibleOutput?.trim();
    if (lifecycle === "item.started") {
      return {
        itemType: "command_execution",
        status: "inProgress",
        title: "Ran command",
        ...(command ? { detail: command } : {}),
      };
    }
    const detail = output ?? command;
    return {
      itemType: "command_execution",
      status: terminalStatus,
      title: "Ran command",
      ...(detail ? { detail } : {}),
    };
  }
  return undefined;
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

export interface MuseTurnIdleWatchdog {
  /** Restart the idle deadline; called for every turn event. */
  readonly markActivity: Effect.Effect<void>;
  /** Resolves once no activity has arrived for the idle window. */
  readonly awaitIdle: Effect.Effect<void>;
}

/**
 * One turn's idle deadline. `awaitIdle` resolves only after `timeoutMs` with
 * no `markActivity`, so the caller can race it against the real terminal and
 * settle the turn locally when the host has gone quiet.
 */
export const makeMuseTurnIdleWatchdog = (timeoutMs: number): Effect.Effect<MuseTurnIdleWatchdog> =>
  Effect.gen(function* () {
    // Monotonic time, not wall clock: an NTP step or VM suspend must not stall
    // or mis-fire the deadline.
    const timeoutNanos = BigInt(Math.max(1, Math.floor(timeoutMs))) * 1_000_000n;
    const lastActivityAtNanos = yield* Ref.make(yield* Clock.monotonicTimeNanos);
    return {
      markActivity: Effect.flatMap(Clock.monotonicTimeNanos, (now) =>
        Ref.set(lastActivityAtNanos, now),
      ),
      awaitIdle: Effect.gen(function* () {
        while (true) {
          const elapsed = (yield* Clock.monotonicTimeNanos) - (yield* Ref.get(lastActivityAtNanos));
          const remaining = timeoutNanos - elapsed;
          if (remaining <= 0n) {
            return;
          }
          yield* Effect.sleep(Duration.nanos(remaining));
        }
      }),
    };
  });

export function makeMuseCodeAdapter(options: MuseCodeAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("museCode");
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const sessionsRef = yield* Ref.make(new Map<ThreadId, MuseSessionRecord>());
    const approvalsRef = yield* Ref.make(new Map<string, PendingMuseApproval>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nativeEventLogger = options.nativeEventLogger;

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

    // Bridges host view notifications onto the shared timeline: todo snapshots
    // become turn.plan.updated (the Tasks badge), toolCall/userShell items
    // become item.started/item.completed (the foldable tool cards). Chat text
    // keeps flowing through turn deltas untouched.
    const emitPlanBridge = (record: MuseSessionRecord, items: ReadonlyArray<TodoItem>) =>
      Effect.gen(function* () {
        const plan = musePlanStepsFromTodos(items);
        if (plan.length === 0) return;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.plan.updated",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: record.threadId,
          ...(record.activeTurnId ? { turnId: TurnId.make(record.activeTurnId) } : {}),
          payload: { explanation: "Muse todos", plan },
          raw: {
            source: RAW_SOURCE,
            method: "session/todoListChanged",
            payload: { sessionId: record.mspSessionId },
          },
        });
      }).pipe(Effect.ignore);

    const emitItemBridge = (
      record: MuseSessionRecord,
      item: {
        readonly kind: string;
        readonly itemId?: string | undefined;
        readonly tool?: string | undefined;
        readonly commandText?: string | undefined;
        readonly visibleOutput?: string | undefined;
        readonly status?: string | undefined;
      },
      lifecycle: "item.started" | "item.completed",
      method: string,
    ) =>
      Effect.gen(function* () {
        const mapped = museItemLifecycle(item, lifecycle);
        if (mapped === undefined) return;
        if (item.itemId !== undefined) {
          yield* markCardItem(record.mspSessionId, item.itemId);
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: lifecycle,
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: record.threadId,
          ...(record.activeTurnId ? { turnId: TurnId.make(record.activeTurnId) } : {}),
          payload: mapped,
          raw: { source: RAW_SOURCE, method, payload: { sessionId: record.mspSessionId } },
        });
      }).pipe(Effect.ignore);

    const readTodoItems = (value: unknown): Array<TodoItem> | undefined => {
      if (!Array.isArray(value)) return undefined;
      const items: Array<TodoItem> = [];
      for (const entry of value) {
        if (
          !isRecord(entry) ||
          typeof entry.text !== "string" ||
          typeof entry.status !== "string"
        ) {
          return undefined;
        }
        items.push({
          text: entry.text,
          status: entry.status,
          ...(typeof entry.activeForm === "string" ? { activeForm: entry.activeForm } : {}),
        });
      }
      return items;
    };

    const readBridgeItem = (
      value: unknown,
    ):
      | {
          readonly kind: string;
          readonly itemId?: string | undefined;
          readonly tool?: string | undefined;
          readonly commandText?: string | undefined;
          readonly visibleOutput?: string | undefined;
          readonly status?: string | undefined;
        }
      | undefined => {
      const raw = isRecord(value) && isRecord(value.item) ? value.item : value;
      if (!isRecord(raw) || typeof raw.kind !== "string") return undefined;
      return {
        kind: raw.kind,
        ...(typeof raw.itemId === "string" ? { itemId: raw.itemId } : {}),
        ...(typeof raw.tool === "string" ? { tool: raw.tool } : {}),
        ...(typeof raw.commandText === "string" ? { commandText: raw.commandText } : {}),
        ...(typeof raw.visibleOutput === "string" ? { visibleOutput: raw.visibleOutput } : {}),
        ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      };
    };

    // Item ids that already have a tool card: their output deltas must not
    // duplicate into chat text. Keyed per session, dropped on stop.
    const cardItemsRef = yield* Ref.make(new Map<string, Set<string>>());
    const markCardItem = (sessionId: string, itemId: string) =>
      Ref.update(cardItemsRef, (entries) => {
        const next = new Map(entries);
        const known = next.get(sessionId) ?? new Set<string>();
        known.add(itemId);
        next.set(sessionId, known);
        return next;
      });
    const dropCardItems = (sessionId: string) =>
      Ref.update(cardItemsRef, (entries) => {
        if (!entries.has(sessionId)) return entries;
        const next = new Map(entries);
        next.delete(sessionId);
        return next;
      });

    // Raw MSP notifications, for post-mortem diagnostics of a wedged turn.
    const logNative = (threadId: ThreadId | null, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (nativeEventLogger === undefined) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Muse notification log.", { cause, method }),
        ),
      );

    const bridgeHostNotifications = (bridgeHost: MuseHost) => {
      bridgeHost.addNotificationHandler((notification) => {
        const isBridged =
          notification.method === "session/todoListChanged" ||
          notification.method === "item/started" ||
          notification.method === "item/completed";
        // Delta frames are the high-frequency tail; skip them synchronously so
        // the notification path stays allocation-light, and only pay for the
        // rest when the bridge or the native log actually wants them.
        if (notification.method.endsWith("/delta")) {
          return;
        }
        if (!isBridged && nativeEventLogger === undefined) {
          return;
        }
        runPromise(
          Effect.gen(function* () {
            const params = isRecord(notification.params) ? notification.params : undefined;
            const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
            const sessions = yield* Ref.get(sessionsRef);
            const record =
              sessionId === undefined
                ? undefined
                : [...sessions.values()].find((entry) => entry.mspSessionId === sessionId);
            yield* logNative(record?.threadId ?? null, notification.method, notification.params);
            if (!isBridged || record === undefined) return;
            if (notification.method === "session/todoListChanged") {
              const items = readTodoItems(params?.items);
              if (items !== undefined) yield* emitPlanBridge(record, items);
              return;
            }
            const item = readBridgeItem(params?.item ?? params);
            if (item === undefined) return;
            yield* emitItemBridge(
              record,
              item,
              notification.method === "item/started" ? "item.started" : "item.completed",
              notification.method,
            );
          }).pipe(Effect.ignore),
        );
      });
    };

    const host: MuseHost = yield* Effect.acquireRelease(
      spawnMuseHost({ museBin: options.museBin, env: options.env }),
      (live) => Effect.promise(() => live.close()).pipe(Effect.ignore),
    );
    bridgeHostNotifications(host);

    // The elevated host spawns lazily on the first full-access session; the
    // semaphore keeps concurrent starts from spawning it twice.
    const elevatedLock = yield* Semaphore.make(1);
    const elevatedHostRef = yield* Ref.make(Option.none<MuseHost>());
    yield* Effect.addFinalizer(() =>
      Ref.get(elevatedHostRef).pipe(
        Effect.flatMap((existing) =>
          Option.isNone(existing)
            ? Effect.void
            : Effect.promise(() => existing.value.close()).pipe(Effect.ignore),
        ),
      ),
    );
    const elevatedHost = elevatedLock.withPermits(1)(
      Effect.flatMap(Ref.get(elevatedHostRef), (existing) =>
        Option.isSome(existing)
          ? Effect.succeed(existing.value)
          : Effect.flatMap(
              spawnMuseHost({
                museBin: options.museBin,
                env: options.env,
                args: MUSE_FULL_ACCESS_SERVE_ARGS,
              }),
              (fresh) =>
                Ref.set(elevatedHostRef, Option.some(fresh)).pipe(
                  Effect.as(fresh),
                  Effect.tap((live) => Effect.sync(() => bridgeHostNotifications(live))),
                ),
            ),
      ),
    );

    // Threads with an orchestration-capable MCP credential get a dedicated
    // host: the credential is per-thread but the host reads one settings.json,
    // so sharing would mix thread identities. The scoped config dir lives
    // under T3 home (never the global muse config) and is removed on stop.
    const dedicatedHostsRef = yield* Ref.make(
      new Map<ThreadId, { host: MuseHost; scopeDir: string }>(),
    );
    const removeScopeDir = (scopeDir: string) =>
      fileSystem.remove(scopeDir, { recursive: true, force: true }).pipe(Effect.ignore);
    const closeDedicatedHost = (entry: { host: MuseHost; scopeDir: string }) =>
      Effect.all(
        [
          Effect.promise(() => entry.host.close()).pipe(Effect.ignore),
          removeScopeDir(entry.scopeDir),
        ],
        { discard: true },
      );
    yield* Effect.addFinalizer(() =>
      Ref.get(dedicatedHostsRef).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach([...entries.values()], closeDedicatedHost, { discard: true }),
        ),
      ),
    );
    const cleanupDedicatedHost = (threadId: ThreadId) =>
      Ref.get(dedicatedHostsRef).pipe(
        Effect.flatMap((entries) => {
          const entry = entries.get(threadId);
          if (entry === undefined) return Effect.void;
          return Ref.update(dedicatedHostsRef, (next) => {
            const copy = new Map(next);
            copy.delete(threadId);
            return copy;
          }).pipe(Effect.andThen(closeDedicatedHost(entry)));
        }),
      );
    const spawnDedicatedOrchestrationHost = (
      threadId: ThreadId,
      mcpSession: McpProviderSession.McpProviderSessionConfig,
      runtimeMode: RuntimeMode | undefined,
    ) => {
      const baseDir = options.env["T3CODE_HOME"]?.trim() || NodeOS.tmpdir();
      const safeThread = String(threadId).replaceAll(/[^A-Za-z0-9_-]/g, "_");
      const scopeDir = pathService.join(baseDir, "muse-mcp", `thread-${safeThread}`);
      const scopeMuseDir = pathService.join(scopeDir, "muse");
      const settingsPath = pathService.join(scopeMuseDir, "settings.json");
      const failScope = (detail: string, cause?: unknown) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "mcp/scopeConfig",
          detail,
          ...(cause instanceof Error ? { cause } : {}),
        });
      return Effect.gen(function* () {
        // The scoped host must behave like the user's normal host: merge the
        // user's own settings (provider/model) and carry the login over. A
        // host without auth.json fails every model call with authRequired.
        const userMuseDir = resolveMuseConfigDir({
          env: options.env,
          homeDir: NodeOS.homedir(),
        });
        const existingSettings = yield* fileSystem
          .readFileString(pathService.join(userMuseDir, "settings.json"))
          .pipe(Effect.option);
        const hasLogin = yield* fileSystem
          .exists(pathService.join(userMuseDir, "auth.json"))
          .pipe(Effect.mapError((cause) => failScope(mspErrorText(cause), cause)));
        if (!hasLogin) {
          return yield* Effect.fail(
            failScope(`muse login not found in ${userMuseDir}: run /login to add an API key`),
          );
        }
        yield* fileSystem.makeDirectory(scopeMuseDir, { recursive: true }).pipe(
          Effect.andThen(() =>
            Effect.all(
              [
                fileSystem.writeFileString(
                  settingsPath,
                  museScopedMcpSettingsDocument({
                    existingSettingsJson: Option.getOrUndefined(existingSettings),
                    endpoint: mcpSession.endpoint,
                    authorizationHeader: mcpSession.authorizationHeader,
                  }),
                ),
                fileSystem.copy(
                  pathService.join(userMuseDir, "auth.json"),
                  pathService.join(scopeMuseDir, "auth.json"),
                ),
                fileSystem
                  .copy(
                    pathService.join(userMuseDir, "trust.json"),
                    pathService.join(scopeMuseDir, "trust.json"),
                  )
                  .pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          ),
          Effect.mapError((cause) => failScope(mspErrorText(cause), cause)),
        );
        const host = yield* spawnMuseHost({
          museBin: options.museBin,
          env: {
            ...McpProviderSession.withAgentDeviceEnvironment(options.env, mcpSession),
            XDG_CONFIG_HOME: scopeDir,
          },
          ...(museNeedsElevatedHost(runtimeMode) ? { args: MUSE_FULL_ACCESS_SERVE_ARGS } : {}),
        });
        bridgeHostNotifications(host);
        yield* Ref.update(dedicatedHostsRef, (entries) =>
          new Map(entries).set(threadId, { host, scopeDir }),
        );
        return host;
      }).pipe(Effect.onError(() => removeScopeDir(scopeDir)));
    };

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
              // Output deltas of items that already have a tool card live in
              // the card detail; streaming them into chat too is the wall of
              // unreadable text. Anything else keeps flowing.
              if (typeof delta.itemId === "string" && delta.itemId.length > 0) {
                const carded =
                  (yield* Ref.get(cardItemsRef)).get(record.mspSessionId)?.has(delta.itemId) ===
                  true;
                if (shouldFoldDelta(delta.field, carded)) {
                  return;
                }
              }
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
        // SessionStartParams carries no effort: the tier is per-turn only.
        // The thread runtime mode selects the session approval mode, and for
        // full-access also the elevated host: sandbox and trust are host-fixed.
        // resumeSession takes no mode, so a resumed session is re-enforced
        // explicitly like Codex re-applies its thread config on resume.
        const approvalMode = museApprovalModeForRuntimeMode(input.runtimeMode);
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        let sessionHost: MuseHost;
        if (mcpSession !== undefined && mcpSession.capabilities.has("orchestration")) {
          sessionHost = yield* spawnDedicatedOrchestrationHost(
            input.threadId,
            mcpSession,
            input.runtimeMode,
          );
        } else {
          sessionHost = museNeedsElevatedHost(input.runtimeMode) ? yield* elevatedHost : host;
        }
        const session = yield* Effect.tryPromise({
          try: () =>
            resumeSessionId !== undefined
              ? sessionHost.client.resumeSession({ sessionId: resumeSessionId })
              : sessionHost.client.startSession({
                  ...(input.cwd ? { workspaceRoot: input.cwd } : {}),
                  ...(input.modelSelection ? { modelId: input.modelSelection.model } : {}),
                  ...(approvalMode === undefined ? {} : { approvalMode }),
                }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: resumeSessionId !== undefined ? "session/resume" : "session/start",
              detail: mspErrorText(cause),
              ...(cause instanceof Error ? { cause } : {}),
            }),
        }).pipe(Effect.onError(() => cleanupDedicatedHost(input.threadId)));
        if (resumeSessionId !== undefined && approvalMode !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              sessionHost.connection.command("session/setApprovalMode", {
                sessionId: session.sessionId,
                mode: approvalMode,
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/setApprovalMode",
                detail: mspErrorText(cause),
                ...(cause instanceof Error ? { cause } : {}),
              }),
          }).pipe(Effect.onError(() => cleanupDedicatedHost(input.threadId)));
        }
        const now = yield* nowIso;
        const record: MuseSessionRecord = {
          session,
          host: sessionHost,
          mspSessionId: session.sessionId,
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
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
        if (turnSelected.effort !== undefined) {
          yield* Ref.update(sessionsRef, (sessions) => {
            const current = sessions.get(input.threadId);
            if (current === undefined) {
              return sessions;
            }
            const next = new Map(sessions);
            next.set(input.threadId, { ...current, effort: turnSelected.effort });
            return next;
          });
        }
        const orchestrationAvailable =
          McpProviderSession.readMcpProviderSession(input.threadId)?.capabilities.has(
            "orchestration",
          ) === true;
        const turn = yield* Effect.tryPromise({
          try: () =>
            record.session.sendUserTurn({
              input: orchestrationAvailable
                ? [
                    {
                      type: "text",
                      text: buildRuntimeInstructions({
                        harness: "Muse",
                        orchestrationAvailable: true,
                      }),
                    },
                    { type: "text", text: prompt },
                  ]
                : [{ type: "text", text: prompt }],
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
            record.host.connection.command("turn/interrupt", {
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
            record.host.connection.command("userInput/answer", {
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
        yield* dropCardItems(record.mspSessionId);
        yield* cleanupDedicatedHost(threadId);
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
          runtimeMode: record.runtimeMode ?? "approval-required",
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
