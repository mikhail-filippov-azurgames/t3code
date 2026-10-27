import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  cacheWorkspaceMatch,
  clearWorkspaceMatchCache,
  readCachedWorkspaceMatch,
  resolveWorkspaceRelativeMatch,
  workspaceLookupQuery,
  workspaceMatchCacheKey,
  workspaceParentDirectory,
} from "./chatFileLink";

describe("workspaceLookupQuery", () => {
  it("asks the index for the final segment", () => {
    expect(workspaceLookupQuery("ChatView.tsx")).toBe("ChatView.tsx");
    expect(workspaceLookupQuery("Tests/Architecture/README.md")).toBe("README.md");
    expect(workspaceLookupQuery("apps\\web\\ChatView.tsx")).toBe("ChatView.tsx");
  });
});

describe("workspaceParentDirectory", () => {
  it("returns the containing directory relative to the workspace root", () => {
    expect(workspaceParentDirectory("README.md")).toBe("");
    expect(workspaceParentDirectory("Tests/Architecture/README.md")).toBe("Tests/Architecture");
    expect(workspaceParentDirectory("./src/main.ts")).toBe("src");
    expect(workspaceParentDirectory("src\\main.ts")).toBe("src");
  });
});

describe("resolveWorkspaceRelativeMatch", () => {
  it("resolves the single nested file that ends with the requested suffix", () => {
    expect(
      resolveWorkspaceRelativeMatch("apps/web/src/components/ChatMarkdown.tsx", [
        { path: "t3code/apps/web/src/components/ChatMarkdown.tsx", kind: "file" },
      ]),
    ).toEqual({ kind: "resolved", path: "t3code/apps/web/src/components/ChatMarkdown.tsx" });
  });

  it("reports ambiguity instead of a miss when sibling copies share the suffix", () => {
    expect(
      resolveWorkspaceRelativeMatch("apps/web/src/components/ChatMarkdown.tsx", [
        { path: "t3code/apps/web/src/components/ChatMarkdown.tsx", kind: "file" },
        { path: "t3code-muse/apps/web/src/components/ChatMarkdown.tsx", kind: "file" },
      ]),
    ).toEqual({ kind: "ambiguous" });
  });

  it("prefers the strictly shallowest suffix match", () => {
    expect(
      resolveWorkspaceRelativeMatch("src/README.md", [
        { path: "packages/app/src/README.md", kind: "file" },
        { path: "app/src/README.md", kind: "file" },
      ]),
    ).toEqual({ kind: "resolved", path: "app/src/README.md" });
  });

  it("reports none when no indexed file carries the suffix", () => {
    expect(
      resolveWorkspaceRelativeMatch("src/README.md", [{ path: "docs/README.md", kind: "file" }]),
    ).toEqual({ kind: "none" });
  });

  it("treats a bare name with several same-named files as ambiguous", () => {
    expect(
      resolveWorkspaceRelativeMatch("index.ts", [
        { path: "src/index.ts", kind: "file" },
        { path: "test/index.ts", kind: "file" },
      ]),
    ).toEqual({ kind: "ambiguous" });
  });

  it("falls back to a lone case-insensitive suffix match", () => {
    expect(
      resolveWorkspaceRelativeMatch("apps/web/ChatMarkdown.tsx", [
        { path: "t3code/Apps/Web/ChatMarkdown.tsx", kind: "file" },
      ]),
    ).toEqual({ kind: "resolved", path: "t3code/Apps/Web/ChatMarkdown.tsx" });
  });

  it("ignores directories", () => {
    expect(
      resolveWorkspaceRelativeMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
      ]),
    ).toEqual({ kind: "none" });
  });
});

describe("workspace match cache", () => {
  beforeEach(() => {
    clearWorkspaceMatchCache();
  });

  it("remembers a hit and a confirmed miss per workspace and path", () => {
    const key = workspaceMatchCacheKey("C:/repo", "Tests/Architecture/README.md");
    expect(readCachedWorkspaceMatch(key)).toEqual({ hit: false, value: null });
    cacheWorkspaceMatch(key, "Tests/Architecture/README.md");
    expect(readCachedWorkspaceMatch(key)).toEqual({
      hit: true,
      value: "Tests/Architecture/README.md",
    });

    const missKey = workspaceMatchCacheKey("C:/repo", "tests/missing.md");
    cacheWorkspaceMatch(missKey, null);
    expect(readCachedWorkspaceMatch(missKey)).toEqual({ hit: true, value: null });

    expect(
      readCachedWorkspaceMatch(workspaceMatchCacheKey("D:/other", "Tests/Architecture/README.md")),
    ).toEqual({ hit: false, value: null });
  });
});
