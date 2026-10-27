import { ThreadId } from "@t3tools/contracts";
import {
  BoardCardId,
  BoardCardLookupToken,
  type BoardCard,
  type BoardCardLookupMatch,
} from "@t3tools/ft3-board/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  boardCardMentionLookupKey,
  boardCardMentionTextSegments,
  boardCardMentionTokenFromInlineCode,
  clearBoardCardMentionCache,
  extractBoardCardLookupTokens,
  resolveBoardCardMentions,
} from "./boardCardMentions";

const card: BoardCard = {
  cardId: BoardCardId.make("b71111aa-0000-4000-8000-000000000001"),
  orchestratorThreadId: ThreadId.make("owner-thread"),
  title: "Fix the board",
  body: "",
  status: "todo",
  readiness: "ready",
  readinessNote: null,
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

  it("extracts a full UUID whole, quoted or bare, without also emitting its prefix", () => {
    const full = "cb37d411-840c-4c70-8fe7-240b1ddc6a10";
    const markdown = [`Quoted \`${full}\`.`, `Bare ${full}, again (${full.toUpperCase()}).`].join(
      "\n",
    );

    assert.deepEqual(extractBoardCardLookupTokens(markdown).map(String), [full]);
    assert.deepEqual(extractBoardCardLookupTokens("Prefix cb37d411.").map(String), ["cb37d411"]);
  });

  it("rejects UUID-shaped text that is longer, shorter or glued to other word characters", () => {
    const full = "cb37d411-840c-4c70-8fe7-240b1ddc6a10";
    for (const text of [
      `x-${full}`,
      `${full}-extra`,
      `${full}f`,
      `a${full}`,
      "cb37d411-840c-4c70",
      "cb37d411-840c-4c70-8fe7",
    ]) {
      assert.deepEqual(extractBoardCardLookupTokens(text).map(String), [], text);
    }
  });

  it("accepts inline code only when it is exactly one card candidate", () => {
    assert.equal(
      boardCardMentionTokenFromInlineCode("  CB37D411-840C-4C70-8FE7-240B1DDC6A10 "),
      "cb37d411-840c-4c70-8fe7-240b1ddc6a10",
    );
    assert.isNull(boardCardMentionTokenFromInlineCode("cb37d411-840c-4c70-8fe7-240b1ddc6a10 x"));
    assert.isNull(boardCardMentionTokenFromInlineCode("cb37d411-840c-4c70-8fe7-240b1ddc6a10-x"));
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

  it("reads card- and card: prefixed ids the way an operator writes them", () => {
    const full = String(card.cardId);
    const fullMatch: BoardCardLookupMatch = {
      ...uniqueMatch,
      token: BoardCardLookupToken.make(full),
    };

    assert.deepEqual(
      extractBoardCardLookupTokens(`Card card-:${full} and card-b71111aa.`).map(String),
      [full, "b71111aa"],
    );

    const segments = boardCardMentionTextSegments(
      `See card-:${full}.`,
      new Map([[full, fullMatch]]),
    );
    assert.deepEqual(
      segments.filter((segment) => segment.match !== null).map((segment) => segment.text),
      [`card-:${full}`],
    );

    assert.equal(boardCardMentionLookupKey(` card-:${full} `), full);
    assert.equal(boardCardMentionLookupKey(` card-${full} `), full);
    assert.equal(boardCardMentionLookupKey(` ${full} `), full);
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

  it("links a full UUID only when the server confirmed that exact token", () => {
    const full = String(card.cardId);
    const fullMatch: BoardCardLookupMatch = {
      ...uniqueMatch,
      token: BoardCardLookupToken.make(full),
    };
    const text = `Card ${full.toUpperCase()} and ${full}.`;

    const linked = boardCardMentionTextSegments(text, new Map([[full, fullMatch]]));
    assert.deepEqual(
      linked.filter((segment) => segment.match !== null).map((segment) => segment.text),
      [full.toUpperCase(), full],
    );
    assert.equal(linked.map((segment) => segment.text).join(""), text);

    const unlinked = boardCardMentionTextSegments(text, new Map([["b71111aa", uniqueMatch]]));
    assert.isTrue(unlinked.every((segment) => segment.match === null));
  });

  it("keys a full UUID by its lowercase form, caches it, and drops absent answers", async () => {
    const full = String(card.cardId);
    const fullMatch: BoardCardLookupMatch = {
      ...uniqueMatch,
      token: BoardCardLookupToken.make(full),
    };
    const missing = BoardCardLookupToken.make("cb37d411-840c-4c70-8fe7-240b1ddc6a10");
    const sent: string[][] = [];
    const read = async (tokens: ReadonlyArray<BoardCardLookupToken>) => {
      sent.push(tokens.map(String));
      return [fullMatch];
    };
    const environmentId = "board-mention-full-uuid-test";
    clearBoardCardMentionCache(environmentId);

    const first = await resolveBoardCardMentions(
      environmentId,
      [BoardCardLookupToken.make(full.toUpperCase()), missing],
      read,
    );
    const second = await resolveBoardCardMentions(
      environmentId,
      [BoardCardLookupToken.make(full)],
      read,
    );

    assert.deepEqual(sent, [[full, String(missing)]]);
    assert.strictEqual(first.get(full), fullMatch);
    assert.isNull(first.get(String(missing)));
    assert.strictEqual(second.get(full), fullMatch);
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
