// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  DelegationCompletedActivityPayload,
  EventId,
  type IsoDateTime,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  DelegatedTaskSummaryRepository,
  MAX_DELEGATED_SUMMARY_ATTEMPTS,
  type DelegatedTaskSummaryRecord,
} from "../persistence/Services/DelegatedTaskSummaries.ts";
import { scrubDelegatedTaskText } from "../DelegatedTaskMemoryText.ts";
import { projectDerivedText } from "../security/SecretTextPolicy.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";

const DELEGATION_COMPLETED = "delegation.completed";
const MAX_REPORT_CHARS = 5_000;
const MAX_EVENT_CHARS = 1_800;
const MAX_SUMMARY_CHARS = 600;
const MAX_SOURCE_TURNS = 32;
const RECOVERY_PAGE_SIZE = 100;
/**
 * Claim lease: how long one paid generation may hold its turn before another
 * claimant may take it. Longer than the 180s provider timeouts so a slow but
 * live generation can never overlap a second paid call for the same turn.
 */
const RETRY_LEASE_MS = 300_000;
/**
 * Retry delay after a transport failure. Longer than the 180s provider
 * timeouts so a retry never fires straight back into the same outage window.
 */
const SUMMARY_RETRY_DELAY_MS = 600_000;

/** Failure wordings that mark a billable attempt as transport, hence retryable. */
const TRANSPORT_FAILURE_PATTERNS = [/timed out/i, /CLI command failed/i];

/**
 * True for transport failures (provider timeout, CLI invocation failure) that
 * are worth one more paid attempt. Every other failure — empty output,
 * invalid output, missing worktree, uncertain prior claim — is terminal and
 * keeps the deterministic fallback.
 */
export function isTransportSummaryFailure(message: string): boolean {
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

function isSummaryLeaseActive(
  retryAfter: DelegatedTaskSummaryRecord["retryAfter"],
  now: IsoDateTime,
): boolean {
  return retryAfter !== null && retryAfter !== undefined && retryAfter > now;
}

/** Legacy terminal error rows with a transport cause and budget left are retried. */
function isRetryableSummaryError(row: DelegatedTaskSummaryRecord): boolean {
  return (
    row.state === "error" &&
    row.attemptCount < MAX_DELEGATED_SUMMARY_ATTEMPTS &&
    row.error !== null &&
    isTransportSummaryFailure(row.error)
  );
}

const decodeTerminal = Schema.decodeUnknownOption(DelegationCompletedActivityPayload);
type ActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.activity-appended" }
>;

interface SummaryWork {
  readonly parentThreadId: ThreadId;
  readonly activity: OrchestrationThreadActivity;
}

export class DelegatedTaskSummaryReactor extends Context.Service<
  DelegatedTaskSummaryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/DelegatedTaskSummaryReactor") {}

function compact(text: string, max: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function compactLines(text: string, max: number): string {
  const normalized = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3).trimEnd()}...`;
}

/** Leads every fallback text so neither agents nor people mistake it for a model summary. */
export const DELEGATED_SUMMARY_NOT_GENERATED_PREFIX = "Summary not generated (raw excerpt).";

export function deterministicDelegatedSummary(
  status: string,
  report: string,
  events: string,
): string {
  const outcome = `${DELEGATED_SUMMARY_NOT_GENERATED_PREFIX} Status: ${status}`;
  const safeReport = projectDerivedText("summary", scrubDelegatedTaskText(report));
  const safeEvents = projectDerivedText("summary", scrubDelegatedTaskText(events));
  const reportPart =
    safeReport.trim().length === 0
      ? "No final assistant text was recorded."
      : compact(safeReport, 430);
  const eventsPart = safeEvents.length === 0 ? "" : ` Evidence: ${compact(safeEvents, 130)}`;
  return projectDerivedText(
    "summary",
    compact(`${outcome}. Report: ${reportPart}.${eventsPart}`, MAX_SUMMARY_CHARS),
  );
}

export interface DelegatedSummaryGenerationContext {
  readonly cwd: string;
  readonly branch: string | null;
  readonly status: string;
  readonly previousSummary: string | null;
  readonly sourceTurnId: TurnId;
  readonly report: string;
  readonly events: string;
  readonly modelSelection: ModelSelection;
}

export function buildDelegatedSummaryGenerationInput(
  context: DelegatedSummaryGenerationContext,
): TextGeneration.CommitMessageGenerationInput {
  const taskContext = [
    "Summarize a completed delegated engineering task turn. Do not invent facts.",
    `Turn status: ${compact(context.status, 40)}.`,
    `Previous summary: ${compact(
      projectDerivedText("summary", scrubDelegatedTaskText(context.previousSummary ?? "(none)")),
      MAX_SUMMARY_CHARS,
    )}`,
    "Return a short subject and 1-3 concise factual detail bullets covering changes, checks, and blockers where present.",
  ].join("\n");
  const safeTaskContext = projectDerivedText("summary", taskContext);
  const report = compact(
    projectDerivedText("summary", scrubDelegatedTaskText(context.report)),
    MAX_REPORT_CHARS,
  );
  const events = compact(
    projectDerivedText("summary", scrubDelegatedTaskText(context.events)),
    MAX_EVENT_CHARS,
  );
  const stagedPatch = [
    `Child final report (${context.sourceTurnId}):`,
    report,
    events.length === 0 ? "" : `Child turn events:\n${events}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_REPORT_CHARS + MAX_EVENT_CHARS + 256);
  return {
    cwd: projectDerivedText("summary", scrubDelegatedTaskText(context.cwd)).slice(0, 1_024),
    branch:
      context.branch === null
        ? null
        : projectDerivedText("summary", scrubDelegatedTaskText(context.branch)).slice(0, 256),
    stagedSummary: safeTaskContext,
    stagedPatch: projectDerivedText("summary", stagedPatch),
    modelSelection: context.modelSelection,
  };
}

export function formatDelegatedSummary(
  result: TextGeneration.CommitMessageGenerationResult,
): string {
  const subject = compact(scrubDelegatedTaskText(result.subject), 150);
  const body = compactLines(scrubDelegatedTaskText(result.body), 400);
  const text = [
    subject.length > 0 ? `Outcome: ${subject}` : "",
    body.length > 0 ? `Details:\n${body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return text.slice(0, MAX_SUMMARY_CHARS).trimEnd();
}

function addMillis(value: IsoDateTime, millis: number): IsoDateTime {
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(value), { milliseconds: millis }),
  ) as IsoDateTime;
}

function stableFingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isDelegationCompletion(event: OrchestrationEvent): event is ActivityAppendedEvent {
  return (
    event.type === "thread.activity-appended" &&
    event.payload.activity.kind === DELEGATION_COMPLETED
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const summaries = yield* DelegatedTaskSummaryRepository;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const inFlight = new Set<string>();

  const processCompletion = Effect.fn("DelegatedTaskSummaryReactor.processCompletion")(function* (
    work: SummaryWork,
  ) {
    const terminal = Option.getOrNull(decodeTerminal(work.activity.payload));
    if (terminal === null) return;
    const childThreadId = terminal.childThreadId;
    const sourceTurnId = terminal.delegatedTurnId;
    const key = `${childThreadId}\u0000${sourceTurnId}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const existing = yield* summaries.getByTurn({ childThreadId, sourceTurnId });
        if (existing?.state === "ready") return;
        const now = DateTime.formatIso(yield* DateTime.now);
        if (existing !== null && isSummaryLeaseActive(existing.retryAfter, now)) return;
        if (existing !== null && existing.state === "error" && !isRetryableSummaryError(existing))
          return;
        if (
          existing !== null &&
          existing.state === "pending" &&
          existing.attemptCount > 0 &&
          (existing.error === null || !isTransportSummaryFailure(existing.error))
        ) {
          yield* summaries.fail({
            childThreadId,
            sourceTurnId,
            error:
              existing.error ??
              "Summary generation outcome is uncertain after a prior durable claim; deterministic summary retained.",
            retryAfter: null,
            final: true,
            updatedAt: now,
          });
          return;
        }

        const childInputOption = yield* snapshots.getDelegatedTaskSummaryInput({
          childThreadId,
          sourceTurnId,
        });
        if (Option.isNone(childInputOption)) return;
        const childInput = childInputOption.value;
        if (childInput.parentThreadId !== work.parentThreadId) return;
        const sourceReport = childInput.assistantText ?? terminal.resultExcerpt ?? "";
        const report = compact(
          projectDerivedText("summary", scrubDelegatedTaskText(sourceReport)),
          MAX_REPORT_CHARS,
        );
        const turnEvents = childInput.activities.map(
          (activity) =>
            `${activity.kind}: ${projectDerivedText(
              "summary",
              scrubDelegatedTaskText(activity.summary),
            )}`,
        );
        const eventContext = compact(
          projectDerivedText("summary", scrubDelegatedTaskText(turnEvents.join("\n"))),
          MAX_EVENT_CHARS,
        );
        const previous = yield* summaries.getLatestBefore({
          childThreadId,
          sourceTurnId,
          completedAt: terminal.completedAt,
        });
        const fingerprint = stableFingerprint({
          previousSummary: projectDerivedText(
            "summary",
            scrubDelegatedTaskText(previous?.text ?? ""),
          ),
          report,
          events: eventContext,
          status: terminal.status,
          terminalError: projectDerivedText(
            "summary",
            scrubDelegatedTaskText(terminal.terminalError ?? ""),
          ),
        });
        const sourceTurnIds = [
          ...new Set([...(previous?.sourceTurnIds ?? []), sourceTurnId]),
        ].slice(-MAX_SOURCE_TURNS);
        const watermark = childInput.threadWatermark;
        const fallback = projectDerivedText(
          "summary",
          deterministicDelegatedSummary(terminal.status, report, eventContext),
        );
        if (existing === null) {
          yield* summaries.insertPending({
            childThreadId,
            parentEnvironmentId: childInput.parentEnvironmentId,
            parentThreadId: work.parentThreadId,
            sourceTurnId,
            completedAt: terminal.completedAt,
            text: fallback,
            source: "deterministic",
            sourceTurnIds,
            watermark,
            contentFingerprint: fingerprint,
            state: "pending",
            error: null,
            attemptCount: 0,
            retryAfter: null,
            updatedAt: now,
          });
        }
        const current = yield* summaries.getByTurn({ childThreadId, sourceTurnId });
        if (current === null || (current.state !== "pending" && !isRetryableSummaryError(current)))
          return;
        if (previous?.contentFingerprint === fingerprint && previous.state === "ready") {
          yield* summaries.complete({
            childThreadId,
            sourceTurnId,
            text: projectDerivedText("summary", scrubDelegatedTaskText(previous.text)),
            source: previous.source,
            sourceTurnIds,
            watermark,
            contentFingerprint: fingerprint,
            updatedAt: now,
          });
          return;
        }
        const parentProjectId = childInput.projectId;
        const projectOption = yield* snapshots.getProjectShellById(parentProjectId);
        const project = Option.getOrNull(projectOption);
        const currentSettings = yield* settings.getSettings;
        const modelSelection = resolveProjectSettings(currentSettings, parentProjectId).settings
          .textGenerationModelSelection;
        const cwd = childInput.worktreePath ?? project?.workspaceRoot ?? "";
        if (cwd.length === 0) {
          yield* summaries.fail({
            childThreadId,
            sourceTurnId,
            error: "Project working directory is unavailable; deterministic summary retained.",
            retryAfter: null,
            final: true,
            updatedAt: now,
          });
          return;
        }

        const generationInput = buildDelegatedSummaryGenerationInput({
          cwd,
          branch: childInput.branch,
          status: terminal.status,
          previousSummary: previous?.text ?? null,
          sourceTurnId,
          report,
          events: eventContext,
          modelSelection,
        });
        const attemptTime = DateTime.formatIso(yield* DateTime.now);
        const retryAfter = addMillis(attemptTime, RETRY_LEASE_MS);
        const claimed = yield* summaries.claimGeneration({
          childThreadId,
          sourceTurnId,
          retryAfter,
          updatedAt: attemptTime,
        });
        if (!claimed) return;

        const result = yield* Effect.result(textGeneration.generateCommitMessage(generationInput));
        if (Result.isSuccess(result)) {
          const generatedText = projectDerivedText(
            "summary",
            formatDelegatedSummary(result.success),
          );
          if (generatedText.length > 0) {
            yield* summaries.complete({
              childThreadId,
              sourceTurnId,
              text: generatedText,
              source: "model",
              sourceTurnIds,
              watermark,
              contentFingerprint: fingerprint,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            });
            return;
          }
        }

        const error = Result.isSuccess(result)
          ? "Text generation returned an empty summary; deterministic summary retained."
          : compact(
              projectDerivedText("summary", scrubDelegatedTaskText(result.failure.message)),
              500,
            ) || "Text generation failed.";
        const failureTime = DateTime.formatIso(yield* DateTime.now);
        // The claim above already spent one budgeted attempt; a transport
        // failure with budget left stays pending on a lease, everything else
        // (or an exhausted budget) is terminal with the deterministic fallback.
        const attemptsUsed = current.attemptCount + 1;
        const retryable =
          isTransportSummaryFailure(error) && attemptsUsed < MAX_DELEGATED_SUMMARY_ATTEMPTS;
        yield* summaries.fail({
          childThreadId,
          sourceTurnId,
          error,
          retryAfter: retryable ? addMillis(failureTime, SUMMARY_RETRY_DELAY_MS) : null,
          final: !retryable,
          updatedAt: failureTime,
        });
      }),
      Effect.sync(() => inFlight.delete(key)),
    );
  });

  const processSafely = (work: SummaryWork) =>
    processCompletion(work).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("delegated task summary processing failed", {
              parentThreadId: work.parentThreadId,
              activityId: work.activity.id,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(processSafely);

  let recoveryCursor: ProjectionSnapshotQuery.DelegatedTaskSummaryRecoveryCursor | undefined;
  const recover = Effect.fn("DelegatedTaskSummaryReactor.recover")(function* () {
    const page = yield* snapshots.listDelegatedTaskSummaryRecoveryCandidates({
      ...(recoveryCursor === undefined ? {} : { after: recoveryCursor }),
      limit: RECOVERY_PAGE_SIZE,
    });
    for (const candidate of page.rows) {
      const payload: DelegationCompletedActivityPayload = {
        version: 1,
        childThreadId: candidate.childThreadId,
        delegatedTurnId: candidate.sourceTurnId,
        status: candidate.status,
        ...(candidate.outputStatus == null ? {} : { outputStatus: candidate.outputStatus }),
        completedAt: candidate.completedAt,
        ...(candidate.resultExcerpt === null ? {} : { resultExcerpt: candidate.resultExcerpt }),
        ...(candidate.terminalError === null ? {} : { terminalError: candidate.terminalError }),
      };
      yield* worker.enqueue({
        parentThreadId: candidate.parentThreadId,
        activity: {
          id: EventId.make(
            `delegation-summary-recovery:${candidate.childThreadId}:${candidate.sourceTurnId}`,
          ),
          tone: candidate.status === "completed" ? "info" : "error",
          kind: DELEGATION_COMPLETED,
          summary: `Recovered delegated child ${candidate.status}`,
          payload,
          turnId: null,
          createdAt: candidate.completedAt,
        },
      });
    }
    // Drain one bounded page per sweep so a durable backlog cannot monopolize the server.
    yield* worker.drain;
    recoveryCursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
  });

  const recoverSafely = recover().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("delegated task summary recovery scan failed; it will retry", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start: DelegatedTaskSummaryReactor["Service"]["start"] = Effect.fn(
    "DelegatedTaskSummaryReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        isDelegationCompletion(event)
          ? worker.enqueue({
              parentThreadId: event.payload.threadId,
              activity: event.payload.activity,
            })
          : Effect.void,
      ),
    );
    yield* forkParked(
      recoverSafely.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies DelegatedTaskSummaryReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskSummaryReactor, make);
