import { projectDerivedText } from "../../ft3-delegation/src/secretTextPolicy.ts";
import type * as TextGeneration from "../../../apps/server/src/textGeneration/TextGeneration.ts";

const REDACTED = "[REDACTED]";
const secretAssignments =
  /(["']?[A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?(?:KEY|TOKEN)|SECRET(?:[_-]?(?:KEY|TOKEN|ACCESS[_-]?KEY))?|REFRESH[_-]?TOKEN|AUTHORIZATION|CLIENT[_-]?SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SESSION[_-]?TOKEN|TOKEN|CREDENTIALS?)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;}\]]+)/gi;
const recognizableTokens =
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gi;
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const privateKey =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const credentialUrl = /([a-z][a-z\d+.-]*:\/\/)[^/\s:@]+:[^/@\s]+@/gi;
const authorizationHeader = /\b(Bearer|Basic)\s+[A-Za-z0-9~+/=_\-.]+/gi;
const cookieHeader = /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi;

export const MAX_REPORT_CHARS = 5_000;
export const MAX_EVENT_CHARS = 1_800;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_SOURCE_TURNS = 32;
export const MAX_SUMMARY_ATTEMPTS = 3;
export const RETRY_LEASE_MS = 300_000;
export const SUMMARY_RETRY_DELAY_MS = 600_000;
const TRANSPORT_FAILURE_PATTERNS = [/timed out/i, /CLI command failed/i];

export const DELEGATED_SUMMARY_NOT_GENERATED_PREFIX = "Summary not generated (raw excerpt).";

export function scrubDelegatedTaskText(input: string): string {
  return input
    .replace(privateKey, REDACTED)
    .replace(credentialUrl, `$1${REDACTED}@`)
    .replace(authorizationHeader, `$1 ${REDACTED}`)
    .replace(cookieHeader, `$1: ${REDACTED}`)
    .replace(secretAssignments, `$1${REDACTED}`)
    .replace(recognizableTokens, REDACTED)
    .replace(jwt, REDACTED);
}

export function safeSummaryText(text: string): string {
  return projectDerivedText("summary", scrubDelegatedTaskText(text));
}

export function isTransportSummaryFailure(message: string): boolean {
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function compact(text: string, max: number): string {
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

export function deterministicDelegatedSummary(
  status: string,
  report: string,
  events: string,
): string {
  const outcome = `${DELEGATED_SUMMARY_NOT_GENERATED_PREFIX} Status: ${status}`;
  const safeReport = safeSummaryText(report);
  const safeEvents = safeSummaryText(events);
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
  readonly sourceTurnId: string;
  readonly report: string;
  readonly events: string;
  readonly modelSelection: TextGeneration.CommitMessageGenerationInput["modelSelection"];
}

export function buildDelegatedSummaryGenerationInput(
  context: DelegatedSummaryGenerationContext,
): TextGeneration.CommitMessageGenerationInput {
  const taskContext = [
    "Summarize a completed delegated engineering task turn. Do not invent facts.",
    `Turn status: ${compact(context.status, 40)}.`,
    `Previous summary: ${compact(safeSummaryText(context.previousSummary ?? "(none)"), MAX_SUMMARY_CHARS)}`,
    "Return a short subject and 1-3 concise factual detail bullets covering changes, checks, and blockers where present.",
  ].join("\n");
  const safeTaskContext = projectDerivedText("summary", taskContext);
  const report = compact(safeSummaryText(context.report), MAX_REPORT_CHARS);
  const events = compact(safeSummaryText(context.events), MAX_EVENT_CHARS);
  const stagedPatch = [
    `Child final report (${context.sourceTurnId}):`,
    report,
    events.length === 0 ? "" : `Child turn events:\n${events}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_REPORT_CHARS + MAX_EVENT_CHARS + 256);
  return {
    cwd: safeSummaryText(context.cwd).slice(0, 1_024),
    branch: context.branch === null ? null : safeSummaryText(context.branch).slice(0, 256),
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
