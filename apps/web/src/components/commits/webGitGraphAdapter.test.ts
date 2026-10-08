import type { VcsCommitHistoryResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMMITS_PAGE_LIMIT,
  createCommitsGraphProvider,
  parseCommitCursor,
  serializeCommitCursor,
  toGitGraphPage,
} from "./webGitGraphAdapter";

const HEAD = "a".repeat(40);
const ROOT = "b".repeat(40);

const RESULT: VcsCommitHistoryResult = {
  isRepo: true,
  nextCursor: { id: ROOT, offset: 2 },
  commits: [
    {
      id: HEAD,
      parents: [ROOT],
      authorName: "Ann",
      authorEmail: "ann@example.com",
      committedAt: "2026-08-17T16:14:00.000Z",
      refs: [
        { kind: "head", name: "HEAD" },
        { kind: "branch", name: "main" },
        { kind: "remote", name: "origin/main" },
        { kind: "tag", name: "v1" },
      ],
      subject: "top commit",
    },
    {
      id: ROOT,
      parents: [],
      authorName: "Bob",
      authorEmail: "bob@example.com",
      committedAt: "2026-08-16T10:00:00.000Z",
      refs: [{ kind: "branch", name: "feature" }],
      subject: "root commit",
    },
  ],
};

describe("toGitGraphPage", () => {
  it("maps commits, refs and cursor to the component shape", () => {
    const page = toGitGraphPage(RESULT);

    expect(page.commits[0]).toEqual({
      oid: HEAD,
      parents: [ROOT],
      message: "top commit",
      kind: "commit",
      author: { name: "Ann", email: "ann@example.com" },
      committedAt: "2026-08-17T16:14:00.000Z",
    });
    expect(page.commits[1]?.parents).toEqual([]);

    // The checked-out branch on the HEAD commit becomes `current`; a branch
    // elsewhere stays a plain local branch (`head`).
    expect(page.refs).toEqual(
      expect.arrayContaining([
        { name: "main", target: HEAD, kind: "current" },
        { name: "origin/main", target: HEAD, kind: "remote" },
        { name: "v1", target: HEAD, kind: "tag" },
        { name: "feature", target: ROOT, kind: "head" },
      ]),
    );
    // The literal HEAD marker is consumed, never rendered as its own chip.
    expect(page.refs.some((ref) => ref.name === "HEAD")).toBe(false);
    expect(page.refs).toHaveLength(4);

    expect(page.head).toBe(HEAD);
    expect(page.hasMore).toBe(true);
    expect(parseCommitCursor(page.cursor)).toEqual({ id: ROOT, offset: 2 });
  });
});

describe("commit cursor", () => {
  it("round-trips and rejects malformed tokens", () => {
    expect(serializeCommitCursor({ id: HEAD, offset: 1 })).toBe(JSON.stringify([HEAD, 1]));
    expect(serializeCommitCursor(null)).toBeUndefined();
    expect(parseCommitCursor(undefined)).toBeUndefined();
    expect(parseCommitCursor("not-json")).toBeUndefined();
    expect(parseCommitCursor(JSON.stringify([HEAD, 0]))).toBeUndefined();
    expect(parseCommitCursor(JSON.stringify([HEAD, 3]))).toEqual({ id: HEAD, offset: 3 });
  });
});

describe("createCommitsGraphProvider", () => {
  it("clamps the requested limit and forwards the decoded cursor", async () => {
    const fetcher = vi.fn(async () => RESULT);
    const provider = createCommitsGraphProvider(fetcher);

    await expect(provider.getCapabilities()).resolves.toMatchObject({
      maxPageSize: COMMITS_PAGE_LIMIT,
    });

    await provider.getHistory({ limit: 200 });
    expect(fetcher).toHaveBeenLastCalledWith({ limit: COMMITS_PAGE_LIMIT });

    await provider.getHistory({ limit: 30, cursor: JSON.stringify([ROOT, 2]) });
    expect(fetcher).toHaveBeenLastCalledWith({ limit: 30, cursor: { id: ROOT, offset: 2 } });
  });
});
