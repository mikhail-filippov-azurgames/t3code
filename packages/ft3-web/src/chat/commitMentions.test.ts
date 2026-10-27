import { describe, expect, it } from "vite-plus/test";

import {
  clearCommitMentionCache,
  extractCommitMentions,
  resolveCommitMentions,
} from "./commitMentions.ts";

const FULL_SHA = "abcdef1234567890abcdef1234567890abcdef12";

describe("extractCommitMentions", () => {
  it("recognizes abbreviated and full SHAs, with or without the commit prefix", () => {
    expect(
      extractCommitMentions(`Fixed in abcdef1 and ${FULL_SHA}, see commit:abcdef123`).map(
        ({ token, sha, explicit }) => ({ token, sha, explicit }),
      ),
    ).toEqual([
      { token: "abcdef1", sha: "abcdef1", explicit: false },
      { token: FULL_SHA, sha: FULL_SHA, explicit: false },
      { token: "commit:abcdef123", sha: "abcdef123", explicit: true },
    ]);
  });

  it("ignores SHAs in fenced code, links and bare URLs", () => {
    const markdown = [
      `Prose ${FULL_SHA}.`,
      "```",
      `git show ${FULL_SHA}`,
      "```",
      `[label](https://example.com/${FULL_SHA})`,
      `https://example.com/commits/${FULL_SHA}`,
    ].join("\n");

    expect(extractCommitMentions(markdown).map(({ sha }) => sha)).toEqual([FULL_SHA]);
  });

  it("keeps exact inline code and rejects hex-looking words and UUIDs", () => {
    expect(extractCommitMentions("Run `abcdef123` now").map(({ sha }) => sha)).toEqual([
      "abcdef123",
    ]);
    expect(extractCommitMentions("abcdefgh nothex")).toEqual([]);
    expect(extractCommitMentions("card b71111aa-0000-4000-8000-000000000001")).toEqual([]);
  });
});

describe("resolveCommitMentions", () => {
  it("resolves an abbreviation only when one commit matches it", async () => {
    const resolved = await resolveCommitMentions(
      "commit-ambiguous",
      "/repo",
      ["abcdef1", "deadbee"],
      async () => [FULL_SHA],
    );

    expect(resolved.get("abcdef1")).toBe(FULL_SHA);
    expect(resolved.get("deadbee")).toBeNull();
  });

  it("batches uncached candidates and caches results by environment and cwd", async () => {
    const batches: string[][] = [];
    const read = async (candidates: ReadonlyArray<string>) => {
      batches.push([...candidates]);
      return [FULL_SHA];
    };
    const environment = "commit-mentions-cache";
    clearCommitMentionCache(environment);
    const first = await resolveCommitMentions(environment, "/repo", ["abcdef123", FULL_SHA], read);
    const second = await resolveCommitMentions(environment, "/repo", ["abcdef123"], read);

    expect(batches).toEqual([["abcdef123", FULL_SHA]]);
    expect(first.get("abcdef123")).toBe(FULL_SHA);
    expect(second.get("abcdef123")).toBe(FULL_SHA);
  });
});
