import {
  BoardCardId,
  BoardCardLookupToken,
  type BoardCard,
  type BoardCardLookupMatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  boardCardMentionTextSegments,
  boardCardMentionTokenFromInlineCode,
  clearBoardCardMentionCache,
  extractBoardCardLookupTokens,
  resolveBoardCardMentions,
} from "./boardCardMentions.ts";

const card: BoardCard = {
  cardId: BoardCardId.make("b71111aa-0000-4000-8000-000000000001"),
  orchestratorThreadId: "owner-thread" as BoardCard["orchestratorThreadId"],
  title: "Fix the board",
  body: "",
  status: "todo",
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const uniqueMatch: BoardCardLookupMatch = {
  token: BoardCardLookupToken.make("b71111aa"),
  card,
  orchestratorThreadTitle: "Owner chat",
  recentEvents: [],
};

describe("board card mentions", () => {
  it("reuses one empty token list for messages without prose tokens", () => {
    assert.strictEqual(
      extractBoardCardLookupTokens("No card token and `variableName`."),
      extractBoardCardLookupTokens("No card token and `anotherVariable`."),
    );
  });

  it("finds prose and exact inline-code tokens while excluding other code and links", () => {
    const markdown = [
      "Mention cc1f5be8 and b71111aa.",
      "Inline `  C0FFEE42  ` is a candidate.",
      "Inline `prefix 22222222` stays code.",
      "Inline `550e8400-e29b-41d4-a716-446655440000` is a full candidate.",
      "```ts",
      "33333333",
      "```",
      "[44444444](https://example.com/44444444)",
      "prefix44444444suffix",
    ].join("\n");

    assert.deepEqual(extractBoardCardLookupTokens(markdown).map(String), [
      "cc1f5be8",
      "b71111aa",
      "c0ffee42",
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
  });

  it("accepts inline code only when it is exactly one card candidate", () => {
    assert.equal(boardCardMentionTokenFromInlineCode("b71111aa"), "b71111aa");
    assert.equal(boardCardMentionTokenFromInlineCode("  B71111AA\n"), "b71111aa");
    assert.equal(
      boardCardMentionTokenFromInlineCode("550e8400-e29b-41d4-a716-446655440000"),
      "550e8400-e29b-41d4-a716-446655440000",
    );
    for (const text of [
      "",
      "variableName",
      "some code",
      "b71111aa extra",
      "b71111aa c0ffee42",
      "b71111aa-extra",
      "b71111aab",
    ]) {
      assert.isNull(boardCardMentionTokenFromInlineCode(text), text);
    }
  });

  it("does not link an inline-code candidate the server left out as ambiguous", () => {
    const segments = boardCardMentionTextSegments("c0ffee42", new Map([["b71111aa", uniqueMatch]]));

    assert.deepEqual(segments, [{ text: "c0ffee42", match: null }]);
  });

  it("links only server-confirmed unique prefixes", () => {
    const segments = boardCardMentionTextSegments(
      "Unique b71111aa; ambiguous c0ffee42.",
      new Map([["b71111aa", uniqueMatch]]),
    );

    assert.deepEqual(
      segments.filter((segment) => segment.match !== null).map((segment) => segment.text),
      ["b71111aa"],
    );
    assert.equal(
      segments.map((segment) => segment.text).join(""),
      "Unique b71111aa; ambiguous c0ffee42.",
    );
  });

  it("caches each token by environment and batches uncached tokens", async () => {
    const token = BoardCardLookupToken.make("b71111aa");
    let readCount = 0;
    const read = async () => {
      readCount += 1;
      return [uniqueMatch];
    };
    const environmentId = "board-mention-cache-test";
    clearBoardCardMentionCache(environmentId);

    await resolveBoardCardMentions(environmentId, [token], read);
    await resolveBoardCardMentions(environmentId, [token], read);
    await resolveBoardCardMentions("another-environment", [token], read);

    assert.strictEqual(readCount, 2);
  });
});
