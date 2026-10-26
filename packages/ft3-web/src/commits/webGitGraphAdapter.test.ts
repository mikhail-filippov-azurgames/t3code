import { describe, expect, it, vi } from "vite-plus/test";

import type { VcsCommitHistoryResult } from "@t3tools/ft3-vcs/contracts";

import {
  createCommitsGraphProvider,
  loadHistoryUntilCommit,
  parseCommitCursor,
  serializeCommitCursor,
  toGitGraphCommit,
  toGitGraphPage,
} from "./webGitGraphAdapter.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");

const page: VcsCommitHistoryResult = {
  commits: [
    {
      id: oid(2),
      parents: [oid(3)],
      authorName: "Alice",
      authorEmail: "alice@example.com",
      committedAt: "2026-10-26T00:00:00.000Z",
      refs: [
        { kind: "head", name: "HEAD" },
        { kind: "branch", name: "main" },
        { kind: "remote", name: "origin/main" },
      ],
      subject: "ship it",
    },
    {
      id: oid(3),
      parents: [],
      authorName: "Bob",
      authorEmail: "bob@example.com",
      committedAt: "2026-10-25T00:00:00.000Z",
      refs: [{ kind: "tag", name: "v1" }],
      subject: "root",
    },
  ],
  isRepo: true,
  nextCursor: { id: oid(3), offset: 2 },
};

describe("commit cursor", () => {
  it("round-trips a cursor and rejects malformed tokens", () => {
    const cursor = { id: oid(3), offset: 7 };
    expect(parseCommitCursor(serializeCommitCursor(cursor))).toEqual(cursor);
    expect(serializeCommitCursor(null)).toBeUndefined();
    expect(parseCommitCursor(undefined)).toBeUndefined();
    expect(parseCommitCursor("not-json")).toBeUndefined();
    expect(parseCommitCursor('["x",0]')).toBeUndefined();
  });
});

describe("toGitGraphCommit / toGitGraphPage", () => {
  it("maps fields and synthesises the checked-out branch as current", () => {
    expect(toGitGraphCommit(page.commits[0]!)).toMatchObject({
      oid: oid(2),
      parents: [oid(3)],
      message: "ship it",
      author: { name: "Alice", email: "alice@example.com" },
    });
    const mapped = toGitGraphPage(page);
    expect(mapped.head).toBe(oid(2));
    expect(mapped.commits).toHaveLength(2);
    expect(mapped.refs).toEqual([
      { name: "main", target: oid(2), kind: "current" },
      { name: "origin/main", target: oid(2), kind: "remote" },
      { name: "v1", target: oid(3), kind: "tag" },
    ]);
    expect(mapped.cursor).toBe(serializeCommitCursor(page.nextCursor));
    expect(mapped.hasMore).toBe(true);
  });

  it("has no head and no cursor on an empty page", () => {
    const mapped = toGitGraphPage({ commits: [], isRepo: true, nextCursor: null });
    expect(mapped.head).toBeUndefined();
    expect(mapped.cursor).toBeUndefined();
    expect(mapped.hasMore).toBe(false);
  });
});

describe("loadHistoryUntilCommit", () => {
  it("stops on the page that contains the commit", async () => {
    const fetcher = vi.fn().mockResolvedValue(page);
    const onPage = vi.fn();
    expect(await loadHistoryUntilCommit(fetcher, oid(2), onPage)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it("follows cursors until it finds the commit", async () => {
    const first = {
      ...page,
      commits: [page.commits[0]!],
      nextCursor: { id: oid(2), offset: 2 },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...page, nextCursor: null });
    const onPage = vi.fn();
    expect(await loadHistoryUntilCommit(fetcher, oid(3), onPage)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("createCommitsGraphProvider", () => {
  it("clamps the page size and decodes the cursor for the server", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ...page, nextCursor: null });
    const provider = createCommitsGraphProvider(fetcher);
    await provider.getHistory({ limit: 500, cursor: serializeCommitCursor(page.nextCursor)! });
    expect(fetcher).toHaveBeenCalledWith({ limit: 100, cursor: { id: oid(3), offset: 2 } });
  });
});
