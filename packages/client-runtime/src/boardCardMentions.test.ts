import {
  BoardCardId,
  BoardCardLookupToken,
  type BoardCard,
  type BoardCardLookupMatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  boardCardMentionTextSegments,
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
      extractBoardCardLookupTokens("No card token."),
      extractBoardCardLookupTokens("No card token."),
    );
    assert.strictEqual(
      extractBoardCardLookupTokens("`11111111`"),
      extractBoardCardLookupTokens("`22222222`"),
    );
  });

  it("finds separate prose tokens and excludes code and formatted links", () => {
    const markdown = [
      "Mention cc1f5be8 and b71111aa.",
      "Inline `11111111` stays code.",
      "```ts",
      "22222222",
      "```",
      "[33333333](https://example.com/33333333)",
      "prefix44444444suffix",
    ].join("\n");

    assert.deepEqual(extractBoardCardLookupTokens(markdown).map(String), ["cc1f5be8", "b71111aa"]);
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
