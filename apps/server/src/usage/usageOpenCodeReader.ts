// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only usage extraction from OpenCode's native SQLite database.
 *
 * Message rows are preferred because they preserve model switches. Parts and
 * session totals are fallbacks for database versions that omit one of those
 * aggregates from the assistant message.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";

import type { UsageSourceStatus } from "@t3tools/contracts";

import { addTotals, totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const OPEN_CODE_UNAVAILABLE_MESSAGE = "OpenCode database could not be read.";
const OPEN_CODE_MISSING_MESSAGE = "OpenCode database is not present on this environment.";
const OPEN_CODE_PARTIAL_MESSAGE = "Some OpenCode usage rows could not be parsed.";
const SQL_IN_CHUNK_SIZE = 500;
type OpenCodeTotals = NonNullable<ReturnType<typeof readTokenTotals>>;

export interface OpenCodeScanResult {
  readonly status: UsageSourceStatus;
  readonly records: readonly UsageRecord[];
  readonly scannedFiles: number;
  readonly skippedFiles: number;
  readonly malformedRecords: number;
  readonly message: string | null;
}

interface OpenCodeSession {
  readonly id: string;
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly totals: OpenCodeTotals | null;
  readonly timeCreated: number | null;
  readonly timeUpdated: number | null;
}

interface OpenCodePartUsage {
  readonly totals: OpenCodeTotals;
  readonly costUsd: number | null;
}

interface OpenCodeMessageRow {
  readonly id: string;
  readonly sessionId: string;
  readonly timeCreated: number | null;
  readonly timeUpdated: number | null;
  readonly data: unknown;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  return null;
}

function nonNegativeInt(value: unknown): number {
  const number = finiteNumber(value);
  return number === null || !Number.isSafeInteger(number) ? 0 : number;
}

function parseJson(value: unknown): unknown | null {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseTimestampMs(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number !== null && number > 0) {
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function readTimeValue(data: Record<string, unknown> | null, key: string): number | null {
  const time = recordOf(data?.["time"]);
  return parseTimestampMs(time?.[key]);
}

function readTokenTotals(value: unknown): {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
} | null {
  const tokens = recordOf(value);
  if (tokens === null) return null;
  const cache = recordOf(tokens["cache"]);
  const outputTokens = nonNegativeInt(tokens["output"]);
  return {
    // OpenCode's input counter excludes the cache counters.
    uncachedInputTokens: nonNegativeInt(tokens["input"]),
    cachedInputTokens: nonNegativeInt(cache?.["read"]),
    cacheCreationTokens: nonNegativeInt(cache?.["write"]),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, nonNegativeInt(tokens["reasoning"])),
  };
}

function readCost(value: unknown): number | null {
  return finiteNumber(value);
}

function formatModel(providerId: unknown, modelId: unknown): string | null {
  const provider = text(providerId);
  const model = text(modelId);
  if (provider !== null && model !== null) return `${provider}/${model}`;
  return model;
}

/** Parses OpenCode's session model JSON or a native model object. */
export function parseOpenCodeModel(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const plain = text(value);
    if (plain === null) return null;
    try {
      parsed = JSON.parse(plain) as unknown;
    } catch {
      return plain.startsWith("{") || plain.startsWith("[") ? null : plain;
    }
  }
  if (parsed === null) return null;
  if (typeof parsed === "string") return text(parsed);

  const model = recordOf(parsed);
  if (model === null) return null;

  const direct = formatModel(
    model["providerID"] ?? model["providerId"] ?? model["provider"],
    model["modelID"] ?? model["modelId"] ?? model["id"],
  );
  if (direct !== null) return direct;

  return parseOpenCodeModel(model["model"]);
}

function parseSession(value: unknown): OpenCodeSession | null {
  const row = recordOf(value);
  const id = text(row?.["id"]);
  if (row === null || id === null) return null;
  return {
    id,
    model: parseOpenCodeModel(row["model"]),
    costUsd: readCost(row["cost"]),
    totals: readTokenTotals({
      input: row["tokens_input"],
      output: row["tokens_output"],
      reasoning: row["tokens_reasoning"],
      cache: { read: row["tokens_cache_read"], write: row["tokens_cache_write"] },
    }),
    timeCreated: parseTimestampMs(row["time_created"]),
    timeUpdated: parseTimestampMs(row["time_updated"]),
  };
}

function parseMessageRow(value: unknown): OpenCodeMessageRow | null {
  const row = recordOf(value);
  const id = text(row?.["id"]);
  const sessionId = text(row?.["session_id"]);
  if (row === null || id === null || sessionId === null) return null;
  return {
    id,
    sessionId,
    timeCreated: parseTimestampMs(row["time_created"]),
    timeUpdated: parseTimestampMs(row["time_updated"]),
    data: row["data"],
  };
}

function parsePartUsage(value: unknown): OpenCodePartUsage | null {
  const row = recordOf(value);
  if (row === null) return null;
  const data = recordOf(parseJson(row["data"]));
  if (data?.["type"] !== "step-finish") return null;
  const totals = readTokenTotals(data["tokens"]);
  if (totals === null || totalTokens(totals) === 0) return null;
  return { totals, costUsd: readCost(data["cost"]) };
}

function parseMessageRecord(
  row: OpenCodeMessageRow,
  session: OpenCodeSession,
  parts: OpenCodePartUsage[],
): UsageRecord | null {
  const data = recordOf(parseJson(row.data));
  if (data === null || data["role"] !== "assistant") return null;

  const model =
    formatModel(data["providerID"] ?? data["providerId"], data["modelID"] ?? data["modelId"]) ??
    parseOpenCodeModel(data["model"]) ??
    session.model;
  if (model === null) return null;

  const messageTotals = readTokenTotals(data["tokens"]);
  let totals = messageTotals;
  let reportedCostUsd = readCost(data["cost"]);
  if (totals === null || totalTokens(totals) === 0) {
    totals = null;
    reportedCostUsd = null;
    for (const part of parts) {
      totals = totals === null ? part.totals : addTotals(totals, part.totals);
      if (part.costUsd !== null) reportedCostUsd = (reportedCostUsd ?? 0) + part.costUsd;
    }
  }
  if (totals === null || totalTokens(totals) === 0) return null;

  const timestampMs =
    readTimeValue(data, "completed") ??
    readTimeValue(data, "created") ??
    row.timeUpdated ??
    row.timeCreated;
  if (timestampMs === null) return null;

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: row.sessionId,
    totals,
    reportedCostUsd,
    dedupeKey: `opencode:message:${row.id}`,
  };
}

function makeSessionRecord(session: OpenCodeSession): UsageRecord | null {
  if (session.totals === null || totalTokens(session.totals) === 0 || session.model === null) {
    return null;
  }
  const timestampMs = session.timeUpdated ?? session.timeCreated;
  if (timestampMs === null) return null;
  return {
    provider: "opencode",
    timestampMs,
    model: session.model,
    sessionId: session.id,
    totals: session.totals,
    reportedCostUsd: session.costUsd,
    dedupeKey: `opencode:session:${session.id}`,
  };
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(",");
}

function queryBySessionIds(
  db: NodeSqlite.DatabaseSync,
  sqlPrefix: string,
  sessionIds: readonly string[],
): readonly unknown[] {
  const rows: unknown[] = [];
  for (let offset = 0; offset < sessionIds.length; offset += SQL_IN_CHUNK_SIZE) {
    const chunk = sessionIds.slice(offset, offset + SQL_IN_CHUNK_SIZE);
    rows.push(...db.prepare(`${sqlPrefix} (${placeholders(chunk.length)})`).all(...chunk));
  }
  return rows;
}

function result(
  status: UsageSourceStatus,
  message: string | null,
  records: readonly UsageRecord[] = [],
  scannedFiles = 0,
  skippedFiles = 0,
  malformedRecords = 0,
): OpenCodeScanResult {
  return { status, message, records, scannedFiles, skippedFiles, malformedRecords };
}

export interface OpenCodeParsedRows {
  readonly records: readonly UsageRecord[];
  readonly malformedRecords: number;
}

/** Folds native session, message, and part rows without touching SQLite. */
export function parseOpenCodeUsageRows(
  sessionRows: readonly unknown[],
  messageRows: readonly unknown[],
  partRows: readonly unknown[],
): OpenCodeParsedRows {
  const sessions = new Map<string, OpenCodeSession>();
  let malformedRecords = 0;
  for (const row of sessionRows) {
    const session = parseSession(row);
    if (session === null) {
      malformedRecords += 1;
      continue;
    }
    sessions.set(session.id, session);
  }

  const partsByMessage = new Map<string, OpenCodePartUsage[]>();
  for (const row of partRows) {
    const raw = recordOf(row);
    const messageId = text(raw?.["message_id"]);
    if (messageId === null) continue;
    const part = parsePartUsage(row);
    if (part === null) continue;
    const parts = partsByMessage.get(messageId) ?? [];
    parts.push(part);
    partsByMessage.set(messageId, parts);
  }

  const records: UsageRecord[] = [];
  const sessionsWithUsage = new Set<string>();
  for (const raw of messageRows) {
    const row = parseMessageRow(raw);
    if (row === null) {
      malformedRecords += 1;
      continue;
    }
    const session = sessions.get(row.sessionId);
    if (session === undefined) continue;
    const data = parseJson(row.data);
    const dataRecord = recordOf(data);
    if (dataRecord === null) {
      malformedRecords += 1;
      continue;
    }
    if (dataRecord["role"] !== "assistant") continue;
    const parts = partsByMessage.get(row.id) ?? [];
    const messageTotals = readTokenTotals(dataRecord["tokens"]);
    const hasUsage = (messageTotals !== null && totalTokens(messageTotals) > 0) || parts.length > 0;
    const record = parseMessageRecord(row, session, parts);
    if (record === null) {
      if (hasUsage) malformedRecords += 1;
      continue;
    }
    records.push(record);
    sessionsWithUsage.add(row.sessionId);
  }

  for (const session of sessions.values()) {
    if (sessionsWithUsage.has(session.id)) continue;
    const record = makeSessionRecord(session);
    if (record === null) {
      if (session.totals !== null && totalTokens(session.totals) > 0) malformedRecords += 1;
      continue;
    }
    records.push(record);
  }

  return { records, malformedRecords };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function resolveOpenCodeDataDirectory(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): string {
  const dataHome = environment.XDG_DATA_HOME?.trim();
  return NodePath.resolve(dataHome || NodePath.join(userHome, ".local", "share"), "opencode");
}

/** Reads one OpenCode database without creating or modifying it. */
export async function readOpenCodeDatabase(
  databasePath: string,
  sinceMs: number,
): Promise<OpenCodeScanResult> {
  try {
    const stats = await NodeFSP.stat(databasePath);
    if (!stats.isFile()) return result("failed", OPEN_CODE_UNAVAILABLE_MESSAGE);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? result("missing", OPEN_CODE_MISSING_MESSAGE)
      : result("failed", OPEN_CODE_UNAVAILABLE_MESSAGE);
  }

  let db: NodeSqlite.DatabaseSync | null = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(databasePath, { readOnly: true });
    const sessionRows = db
      .prepare(
        "SELECT id, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session WHERE time_updated >= ? OR time_created >= ?",
      )
      .all(sinceMs, sinceMs);
    const sessionIds = sessionRows.flatMap((row) => {
      const session = parseSession(row);
      return session === null ? [] : [session.id];
    });
    const partRows = queryBySessionIds(
      db,
      "SELECT message_id, data FROM part WHERE session_id IN",
      sessionIds,
    );
    const messageRows = queryBySessionIds(
      db,
      "SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id IN",
      sessionIds,
    );
    const parsed = parseOpenCodeUsageRows(sessionRows, messageRows, partRows);

    return parsed.malformedRecords === 0
      ? result("ok", null, parsed.records, 1)
      : result("partial", OPEN_CODE_PARTIAL_MESSAGE, parsed.records, 1, 0, parsed.malformedRecords);
  } catch {
    return result("failed", OPEN_CODE_UNAVAILABLE_MESSAGE);
  } finally {
    try {
      db?.close();
    } catch {
      // The source status already describes a failed read; close errors add no signal.
    }
  }
}
