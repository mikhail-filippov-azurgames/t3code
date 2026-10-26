// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { resolveProjectSettings } from "../../shared/src/projectSettings.ts";
import {
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../../apps/server/src/orchestration-v2/EventSink.ts";
import * as ProjectStore from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../../../apps/server/src/environment/ServerEnvironment.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as TextGeneration from "../../../apps/server/src/textGeneration/TextGeneration.ts";
import { forkParked } from "../../../apps/server/src/serverActivation.ts";
import * as SummaryRepository from "./DelegatedTaskSummaryRepository.ts";
import {
  buildDelegatedSummaryGenerationInput,
  compact,
  deterministicDelegatedSummary,
  formatDelegatedSummary,
  isTransportSummaryFailure,
  MAX_EVENT_CHARS,
  MAX_REPORT_CHARS,
  MAX_SOURCE_TURNS,
  MAX_SUMMARY_CHARS,
  RETRY_LEASE_MS,
  SUMMARY_RETRY_DELAY_MS,
  safeSummaryText,
} from "./DelegatedTaskSummaryText.ts";

const TERMINAL_TURN_STATUSES: ReadonlySet<OrchestrationV2ProviderTurn["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

interface TurnSnapshot {
  readonly turn: OrchestrationV2ProviderTurn;
  readonly report: string;
  readonly events: string;
  readonly terminalError: string | null;
}

interface GenerationInputs {
  readonly status: string;
  readonly previous: SummaryRepository.SummaryRecord | null;
  readonly fingerprint: string;
  readonly sourceTurnIds: ReadonlyArray<string>;
  readonly fallback: string;
  readonly completedAt: string;
  readonly branch: string | null;
  readonly cwd: string;
  readonly modelSelection: TextGeneration.CommitMessageGenerationInput["modelSelection"];
  readonly report: string;
  readonly events: string;
  readonly terminalError: string | null;
  readonly watermark: number;
}

const now = Effect.map(DateTime.now, DateTime.formatIso);
const addMillis = (value: string, millis: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(value), { milliseconds: millis }));
const stableFingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const isLeaseActive = (retryAfter: string | null, at: string) =>
  retryAfter !== null && retryAfter > at;
const isRetryableError = (row: SummaryRepository.SummaryRecord) =>
  row.state === "error" &&
  row.attemptCount < 3 &&
  row.error !== null &&
  isTransportSummaryFailure(row.error);

const turnItemLine = (item: {
  readonly type: string;
  readonly title: string | null;
  readonly failure?: { readonly message: string };
}): string => {
  if (item.type === "error" && item.failure !== undefined) return `error: ${item.failure.message}`;
  return `${item.type}: ${item.title?.trim() || item.type}`;
};

export class DelegatedTaskSummaryReactor extends Context.Service<
  DelegatedTaskSummaryReactor,
  {
    readonly process: (event: OrchestrationV2StoredEvent) => Effect.Effect<void>;
    readonly recover: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/ft3-orchestration/DelegatedTaskSummaryReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const summaries = yield* SummaryRepository.DelegatedTaskSummaryRepository;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const lane = yield* Semaphore.make(1);
  const inFlight = new Set<string>();

  const cursor = Effect.fn("Ft3DelegatedSummaryReactor.cursor")(function* () {
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM ft3_delegated_task_summary_reactor_cursor WHERE id = 1`;
    return rows[0]?.sequence ?? 0;
  });

  const loadTurn = Effect.fn("Ft3DelegatedSummaryReactor.loadTurn")(function* (
    shell: OrchestrationV2ThreadShell,
    sourceTurnId: string,
  ) {
    const records = yield* threads.getThreadRecords(shell.id, ["providerTurns", "turnItems"]);
    const turn = records.providerTurns.find((candidate) => String(candidate.id) === sourceTurnId);
    if (turn === undefined) return null;
    const items = records.turnItems
      .filter(
        (item) => item.providerTurnId !== null && String(item.providerTurnId) === sourceTurnId,
      )
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const report = items
      .flatMap((item) => (item.type === "assistant_message" && !item.streaming ? [item.text] : []))
      .join("\n");
    const events = compact(
      items
        .filter(
          (item) =>
            item.type !== "user_message" &&
            item.type !== "assistant_message" &&
            item.type !== "reasoning",
        )
        .map(turnItemLine)
        .join("\n"),
      MAX_EVENT_CHARS,
    );
    const errorItem = items.filter((item) => item.type === "error").at(-1);
    return {
      turn,
      report,
      events,
      terminalError:
        errorItem !== undefined && errorItem.type === "error"
          ? errorItem.failure.message
          : (shell.lastError ?? null),
    } satisfies TurnSnapshot;
  });

  const buildInputs = Effect.fn("Ft3DelegatedSummaryReactor.buildInputs")(function* (
    shell: OrchestrationV2ThreadShell,
    snapshot: TurnSnapshot,
    sourceTurnId: string,
    watermark: number,
    completedAtFallback: string,
  ) {
    const safeReport = compact(safeSummaryText(snapshot.report), MAX_REPORT_CHARS);
    const safeEvents = compact(safeSummaryText(snapshot.events), MAX_EVENT_CHARS);
    const previous = yield* summaries.getLatestBefore({
      childThreadId: String(shell.id),
      sourceTurnId,
      completedAt: DateTime.formatIso(
        snapshot.turn.completedAt ?? DateTime.makeUnsafe(completedAtFallback),
      ),
    });
    const fingerprint = stableFingerprint({
      previousSummary: safeSummaryText(previous?.text ?? ""),
      report: safeReport,
      events: safeEvents,
      status: snapshot.turn.status,
      terminalError: safeSummaryText(snapshot.terminalError ?? ""),
    });
    const sourceTurnIds = [...new Set([...(previous?.sourceTurnIds ?? []), sourceTurnId])].slice(
      -MAX_SOURCE_TURNS,
    );
    const project = yield* projects.get(shell.projectId);
    const projectSettings = resolveProjectSettings(
      yield* settings.getSettings,
      shell.projectId,
    ).settings;
    return {
      status: snapshot.turn.status,
      previous,
      fingerprint,
      sourceTurnIds,
      fallback: safeSummaryText(
        deterministicDelegatedSummary(snapshot.turn.status, safeReport, safeEvents),
      ),
      completedAt: DateTime.formatIso(
        snapshot.turn.completedAt ?? DateTime.makeUnsafe(completedAtFallback),
      ),
      branch: shell.branch,
      cwd: shell.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : ""),
      modelSelection: projectSettings.textGenerationModelSelection,
      report: safeReport,
      events: safeEvents,
      terminalError: snapshot.terminalError,
      watermark,
    } satisfies GenerationInputs;
  });

  const stage = Effect.fn("Ft3DelegatedSummaryReactor.stage")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    const { event } = stored;
    if (event.type !== "provider-turn.updated" || !TERMINAL_TURN_STATUSES.has(event.payload.status))
      return;
    const shell = yield* threads.getThreadShell(event.threadId);
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.lineage.relationshipToParent !== "subagent" ||
      shell.lineage.parentThreadId === null
    )
      return;
    const parent = yield* threads.getThreadShell(shell.lineage.parentThreadId);
    if (parent === null || parent.deletedAt !== null) return;
    const sourceTurnId = String(event.payload.id);
    const existing = yield* summaries.getByTurn({
      childThreadId: String(shell.id),
      sourceTurnId,
    });
    if (existing !== null) return;
    const snapshot = yield* loadTurn(shell, sourceTurnId);
    if (snapshot === null) return;
    const inputs = yield* buildInputs(
      shell,
      snapshot,
      sourceTurnId,
      stored.sequence,
      DateTime.formatIso(event.occurredAt),
    );
    yield* summaries.insertPending({
      childThreadId: String(shell.id),
      parentEnvironmentId: yield* environment.getEnvironmentId,
      parentThreadId: String(parent.id),
      sourceTurnId,
      completedAt: inputs.completedAt,
      text: inputs.fallback,
      source: "deterministic",
      sourceTurnIds: inputs.sourceTurnIds,
      watermark: inputs.watermark,
      contentFingerprint: inputs.fingerprint,
      state: "pending",
      error: null,
      attemptCount: 0,
      retryAfter: null,
      updatedAt: yield* now,
    });
  });

  const processPending = Effect.fn("Ft3DelegatedSummaryReactor.processPending")(function* (
    row: SummaryRepository.SummaryRecord,
  ) {
    const at = yield* now;
    if (isLeaseActive(row.retryAfter, at)) return;
    if (row.state === "ready") return;
    if (row.state === "error" && !isRetryableError(row)) return;
    if (
      row.state === "pending" &&
      row.attemptCount > 0 &&
      (row.error === null || !isTransportSummaryFailure(row.error))
    ) {
      yield* summaries.fail({
        childThreadId: row.childThreadId,
        sourceTurnId: row.sourceTurnId,
        error:
          row.error ??
          "Summary generation outcome is uncertain after a prior durable claim; deterministic summary retained.",
        retryAfter: null,
        final: true,
        updatedAt: at,
      });
      return;
    }
    const childThreadId = row.childThreadId as ThreadId;
    const shell = yield* threads.getThreadShell(childThreadId);
    if (shell === null || shell.deletedAt !== null) {
      yield* summaries.fail({
        childThreadId: row.childThreadId,
        sourceTurnId: row.sourceTurnId,
        error: "The delegated child thread is unavailable; deterministic summary retained.",
        retryAfter: null,
        final: true,
        updatedAt: at,
      });
      return;
    }
    const snapshot = yield* loadTurn(shell, row.sourceTurnId);
    if (snapshot === null) {
      yield* summaries.fail({
        childThreadId: row.childThreadId,
        sourceTurnId: row.sourceTurnId,
        error: "The summarized provider turn is unavailable; deterministic summary retained.",
        retryAfter: null,
        final: true,
        updatedAt: at,
      });
      return;
    }
    const inputs = yield* buildInputs(
      shell,
      snapshot,
      row.sourceTurnId,
      row.watermark,
      row.completedAt,
    );
    if (inputs.cwd.length === 0) {
      yield* summaries.fail({
        childThreadId: row.childThreadId,
        sourceTurnId: row.sourceTurnId,
        error: "Project working directory is unavailable; deterministic summary retained.",
        retryAfter: null,
        final: true,
        updatedAt: at,
      });
      return;
    }
    if (
      inputs.previous?.contentFingerprint === inputs.fingerprint &&
      inputs.previous.state === "ready"
    ) {
      yield* summaries.complete({
        childThreadId: row.childThreadId,
        sourceTurnId: row.sourceTurnId,
        text: inputs.previous.text,
        source: inputs.previous.source,
        sourceTurnIds: inputs.sourceTurnIds,
        watermark: row.watermark,
        contentFingerprint: inputs.fingerprint,
        updatedAt: at,
      });
      return;
    }
    const claimed = yield* summaries.claimGeneration({
      childThreadId: row.childThreadId,
      sourceTurnId: row.sourceTurnId,
      retryAfter: addMillis(at, RETRY_LEASE_MS),
      updatedAt: at,
    });
    if (!claimed) return;
    const result = yield* Effect.result(
      textGeneration.generateCommitMessage(
        buildDelegatedSummaryGenerationInput({
          cwd: inputs.cwd,
          branch: inputs.branch,
          status: inputs.status,
          previousSummary: inputs.previous?.text ?? null,
          sourceTurnId: row.sourceTurnId,
          report: inputs.report,
          events: inputs.events,
          modelSelection: inputs.modelSelection,
        }),
      ),
    );
    if (Result.isSuccess(result)) {
      const generatedText = safeSummaryText(formatDelegatedSummary(result.success));
      if (generatedText.length > 0) {
        yield* summaries.complete({
          childThreadId: row.childThreadId,
          sourceTurnId: row.sourceTurnId,
          text: generatedText,
          source: "model",
          sourceTurnIds: inputs.sourceTurnIds,
          watermark: row.watermark,
          contentFingerprint: inputs.fingerprint,
          updatedAt: yield* now,
        });
        return;
      }
    }
    const error = Result.isSuccess(result)
      ? "Text generation returned an empty summary; deterministic summary retained."
      : compact(safeSummaryText(result.failure.message), 500) || "Text generation failed.";
    const failureTime = yield* now;
    const attemptsUsed = row.attemptCount + 1;
    const retryable = isTransportSummaryFailure(error) && attemptsUsed < 3;
    yield* summaries.fail({
      childThreadId: row.childThreadId,
      sourceTurnId: row.sourceTurnId,
      error,
      retryAfter: retryable ? addMillis(failureTime, SUMMARY_RETRY_DELAY_MS) : null,
      final: !retryable,
      updatedAt: failureTime,
    });
  });

  const safely = <E, R>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Delegated summary reactor step failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const drain = safely(
    Effect.gen(function* () {
      const pending = yield* summaries.listPending();
      for (const row of pending) {
        const key = `${row.childThreadId}\u0000${row.sourceTurnId}`;
        if (inFlight.has(key)) continue;
        inFlight.add(key);
        yield* processPending(row).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("delegated task summary generation failed", {
                  childThreadId: row.childThreadId,
                  sourceTurnId: row.sourceTurnId,
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
        );
      }
    }),
  );

  const processUnsafe = Effect.fn("Ft3DelegatedSummaryReactor.process")(
    function* (stored: OrchestrationV2StoredEvent) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (stored.sequence <= (yield* cursor())) return;
          yield* stage(stored);
          yield* sql`UPDATE ft3_delegated_task_summary_reactor_cursor
            SET sequence = ${stored.sequence} WHERE id = 1`;
        }),
      );
      yield* drain;
    },
    (effect) => lane.withPermit(effect),
  );
  const process = (stored: OrchestrationV2StoredEvent) => safely(processUnsafe(stored));

  const recover = safely(
    Effect.gen(function* () {
      const afterSequence = yield* cursor();
      const throughSequence = yield* sink.latestSequence();
      if (throughSequence > afterSequence) {
        yield* sink.stream({ afterSequence }).pipe(
          Stream.takeUntil((stored) => stored.sequence >= throughSequence),
          Stream.runForEach(process),
        );
      }
      yield* lane.withPermit(drain);
    }),
  );

  const start = Effect.fn("Ft3DelegatedSummaryReactor.start")(function* () {
    yield* forkParked(
      Effect.forever(
        Effect.gen(function* () {
          yield* recover;
          const afterSequence = yield* cursor();
          yield* sink.stream({ afterSequence }).pipe(Stream.runForEach(process));
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Delegated summary reactor failed; resuming from its cursor", {
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.andThen(Effect.sleep("1 second")),
        ),
      ),
    );
  });

  return DelegatedTaskSummaryReactor.of({ process, recover, drain, start });
});

export const layer = Layer.effect(DelegatedTaskSummaryReactor, make);

export const layerWorker = () =>
  Layer.effectDiscard(
    Effect.flatMap(DelegatedTaskSummaryReactor, (reactor) => reactor.start()),
  ).pipe(Layer.provide(layer), Layer.provide(SummaryRepository.layer));
