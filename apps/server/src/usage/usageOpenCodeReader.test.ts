// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import {
  parseOpenCodeModel,
  parseOpenCodeUsageRows,
  readOpenCodeDatabase,
  resolveOpenCodeDataDirectory,
} from "./usageOpenCodeReader.ts";

const AUGUST_1 = Date.parse("2026-08-01T00:00:00Z");
const AUGUST_2 = Date.parse("2026-08-02T00:00:00Z");

interface SessionFixture {
  readonly id: string;
  readonly model: string;
  readonly cost: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}

interface MessageFixture {
  readonly id: string;
  readonly sessionId: string;
  readonly data: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}

interface PartFixture {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly data: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}

function session(overrides: Partial<SessionFixture> = {}): SessionFixture {
  return {
    id: "session-1",
    model: JSON.stringify({ providerID: "opencode-go", modelID: "fallback-model" }),
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    timeCreated: AUGUST_1 + 1_000,
    timeUpdated: AUGUST_2 + 1_000,
    ...overrides,
  };
}

function assistantMessage(input: {
  readonly id: string;
  readonly sessionId?: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly cost: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly completed: number;
}): MessageFixture {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "session-1",
    timeCreated: input.completed - 100,
    timeUpdated: input.completed,
    data: JSON.stringify({
      role: "assistant",
      providerID: input.providerID,
      modelID: input.modelID,
      cost: input.cost,
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: input.reasoning,
        cache: { read: input.cacheRead, write: input.cacheWrite },
      },
      time: { created: input.completed - 100, completed: input.completed },
    }),
  };
}

function stepFinishPart(input: {
  readonly id: string;
  readonly messageId: string;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}): PartFixture {
  return {
    id: input.id,
    messageId: input.messageId,
    sessionId: "session-1",
    timeCreated: AUGUST_1 + 30_000,
    timeUpdated: AUGUST_1 + 30_001,
    data: JSON.stringify({
      type: "step-finish",
      cost: input.cost,
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: input.reasoning,
        cache: { read: input.cacheRead, write: input.cacheWrite },
      },
    }),
  };
}

function sessionRow(value: SessionFixture): Record<string, unknown> {
  return {
    id: value.id,
    model: value.model,
    cost: value.cost,
    tokens_input: value.input,
    tokens_output: value.output,
    tokens_reasoning: value.reasoning,
    tokens_cache_read: value.cacheRead,
    tokens_cache_write: value.cacheWrite,
    time_created: value.timeCreated,
    time_updated: value.timeUpdated,
  };
}

function messageRow(value: MessageFixture): Record<string, unknown> {
  return {
    id: value.id,
    session_id: value.sessionId,
    time_created: value.timeCreated,
    time_updated: value.timeUpdated,
    data: value.data,
  };
}

function partRow(value: PartFixture): Record<string, unknown> {
  return {
    message_id: value.messageId,
    session_id: value.sessionId,
    data: value.data,
  };
}

describe("OpenCode usage reader", () => {
  it("parses provider and model identifiers without trusting malformed JSON", () => {
    assert.strictEqual(
      parseOpenCodeModel('{"providerID":"opencode-go","modelID":"kimi-k2.7-code"}'),
      "opencode-go/kimi-k2.7-code",
    );
    assert.strictEqual(
      parseOpenCodeModel({ providerID: "meta", modelID: "muse-spark-1.2" }),
      "meta/muse-spark-1.2",
    );
    assert.strictEqual(parseOpenCodeModel("plain-model-id"), "plain-model-id");
    assert.isNull(parseOpenCodeModel("{not-json"));
    assert.isNull(parseOpenCodeModel({ providerID: "meta" }));
  });

  it("maps message, part, and session usage while preserving model switches", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-usage-test-"));
    try {
      const oldDay = Date.parse("2026-07-31T23:00:00Z");
      const parsed = parseOpenCodeUsageRows(
        [
          session(),
          session({
            id: "session-fallback",
            model: JSON.stringify({ providerID: "opencode-go", modelID: "fallback-model" }),
            cost: 3,
            input: 11,
            output: 33,
            reasoning: 4,
            cacheRead: 22,
            cacheWrite: 5,
            timeCreated: AUGUST_1 + 1_000,
            timeUpdated: AUGUST_1 + 2_000,
          }),
        ].map(sessionRow),
        [
          assistantMessage({
            id: "message-outside-window",
            providerID: "opencode-go",
            modelID: "outside-window",
            cost: 9,
            input: 1,
            output: 2,
            reasoning: 0,
            cacheRead: 3,
            cacheWrite: 0,
            completed: oldDay,
          }),
          assistantMessage({
            id: "message-old-model",
            providerID: "meta",
            modelID: "old-model",
            cost: 1.25,
            input: 10,
            output: 5,
            reasoning: 2,
            cacheRead: 100,
            cacheWrite: 3,
            completed: AUGUST_1 + 10_000,
          }),
          assistantMessage({
            id: "message-new-model",
            providerID: "opencode-go",
            modelID: "new-model",
            cost: 2.5,
            input: 20,
            output: 7,
            reasoning: 3,
            cacheRead: 50,
            cacheWrite: 4,
            completed: AUGUST_1 + 20_000,
          }),
          assistantMessage({
            id: "message-part-usage",
            providerID: "opencode-go",
            modelID: "part-model",
            cost: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            completed: AUGUST_1 + 30_000,
          }),
        ].map(messageRow),
        [
          stepFinishPart({
            id: "part-usage",
            messageId: "message-part-usage",
            input: 8,
            output: 4,
            reasoning: 1,
            cacheRead: 2,
            cacheWrite: 1,
            cost: 0.75,
          }),
          stepFinishPart({
            id: "part-usage-2",
            messageId: "message-part-usage",
            input: 1,
            output: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.25,
          }),
        ].map(partRow),
      );
      assert.strictEqual(parsed.malformedRecords, 0);
      assert.strictEqual(parsed.records.length, 5);

      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-01",
        rates: new Map(),
      });
      for (const record of parsed.records) aggregator.add(record);
      const { buckets, outOfWindow } = aggregator.finish();

      assert.strictEqual(outOfWindow, 1);
      assert.strictEqual(buckets.length, 4);
      assert.strictEqual(
        buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
        7.75,
      );
      assert.strictEqual(
        buckets.reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0),
        50,
      );

      const partBucket = buckets.find((bucket) => bucket.model === "opencode-go/part-model");
      assert.deepStrictEqual(partBucket?.totals, {
        uncachedInputTokens: 9,
        cachedInputTokens: 2,
        cacheCreationTokens: 1,
        outputTokens: 5,
        reasoningTokens: 1,
      });
      assert.strictEqual(partBucket?.costUsd, 1);
      assert.strictEqual(partBucket?.costSource, "providerReported");
      assert.strictEqual(
        buckets.find((bucket) => bucket.model === "opencode-go/fallback-model")?.sessions,
        1,
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports missing and corrupt databases as nonfatal source statuses", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-status-test-"));
    try {
      const databasePath = NodePath.join(dir, "opencode.db");
      const missing = await readOpenCodeDatabase(databasePath, AUGUST_1);
      assert.strictEqual(missing.status, "missing");
      assert.deepStrictEqual(missing.records, []);

      await NodeFSP.writeFile(databasePath, "not a sqlite database");
      const corrupt = await readOpenCodeDatabase(databasePath, AUGUST_1);
      assert.strictEqual(corrupt.status, "failed");
      assert.deepStrictEqual(corrupt.records, []);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves XDG data before the user-profile fallback", () => {
    const userHome = NodePath.join("C:\\Users", "fixture");
    assert.strictEqual(
      resolveOpenCodeDataDirectory({ XDG_DATA_HOME: NodePath.join(userHome, "xdg") }, userHome),
      NodePath.join(userHome, "xdg", "opencode"),
    );
    assert.strictEqual(
      resolveOpenCodeDataDirectory({}, userHome),
      NodePath.join(userHome, ".local", "share", "opencode"),
    );
  });
});
