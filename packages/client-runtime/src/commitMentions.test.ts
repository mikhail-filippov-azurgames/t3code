import { assert, describe, it } from "@effect/vitest";

import {
  clearCommitMentionCache,
  extractCommitMentions,
  resolveCommitMentions,
} from "./commitMentions.ts";

describe("commit mentions", () => {
  it("recognizes explicit SHAs and bare seven or nine-to-forty digit candidates", () => {
    assert.deepEqual(
      extractCommitMentions(
        "commit:abcdef1 abcdef1 abcdef12 abcdef123 0123456789abcdef0123456789abcdef01234567",
      ).map(({ token, sha, explicit }) => ({ token, sha, explicit })),
      [
        { token: "commit:abcdef1", sha: "abcdef1", explicit: true },
        { token: "abcdef1", sha: "abcdef1", explicit: false },
        { token: "abcdef12", sha: "abcdef12", explicit: false },
        { token: "abcdef123", sha: "abcdef123", explicit: false },
        {
          token: "0123456789abcdef0123456789abcdef01234567",
          sha: "0123456789abcdef0123456789abcdef01234567",
          explicit: false,
        },
      ],
    );
  });

  it("leaves bare eight-character tokens for card and commit double resolution", () => {
    assert.deepEqual(
      extractCommitMentions("b71111aa").map(({ sha }) => sha),
      ["b71111aa"],
    );
    assert.deepEqual(
      extractCommitMentions("commit:b71111aa").map(({ sha }) => sha),
      ["b71111aa"],
    );
  });

  it("skips links and fenced code while accepting exact inline code", () => {
    const mentions = extractCommitMentions(
      "Text abcdef1, `abcdef123`, [deadbee](https://example.com/deadbee)\n```\nfeedbee\n```",
    );
    assert.deepEqual(
      mentions.map(({ sha }) => sha),
      ["abcdef1", "abcdef123"],
    );
    assert.deepEqual(
      extractCommitMentions("Card id b71111aa-0000-4000-8000-000000000001").map(({ sha }) => sha),
      [],
    );
  });

  it("batches uncached candidates and caches exact and abbreviated results by environment and cwd", async () => {
    const full = "abcdef1234567890abcdef1234567890abcdef12";
    const batches: string[][] = [];
    const read = async (candidates: ReadonlyArray<string>) => {
      batches.push([...candidates]);
      return [full];
    };
    const environment = "commit-mentions-cache";
    clearCommitMentionCache(environment);
    const first = await resolveCommitMentions(environment, "/repo", ["abcdef123", full], read);
    const second = await resolveCommitMentions(environment, "/repo", ["abcdef123"], read);
    assert.deepEqual(batches, [["abcdef123", full]]);
    assert.equal(first.get("abcdef123"), full);
    assert.equal(second.get("abcdef123"), full);
  });
});
