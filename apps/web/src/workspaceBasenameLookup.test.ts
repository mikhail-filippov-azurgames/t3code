import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  cacheWorkspaceMatch,
  claimWorkspaceBasenameLookup,
  clearWorkspaceMatchCache,
  needsWorkspaceBasenameLookup,
  pickWorkspaceRelativeMatch,
  readCachedWorkspaceMatch,
  workspaceLookupQuery,
  workspaceMatchCacheKey,
  workspaceParentDirectory,
} from "./workspaceBasenameLookup";

describe("needsWorkspaceBasenameLookup", () => {
  it("flags bare and nested relative paths", () => {
    expect(needsWorkspaceBasenameLookup("ChatView.tsx")).toBe(true);
    expect(needsWorkspaceBasenameLookup("Makefile")).toBe(true);
    expect(needsWorkspaceBasenameLookup("apps/web/src/components/ChatView.tsx")).toBe(true);
    expect(needsWorkspaceBasenameLookup("Tests/Architecture/README.md")).toBe(true);
    expect(needsWorkspaceBasenameLookup("apps\\web\\ChatView.tsx")).toBe(true);
  });

  it("leaves absolute host paths and blanks alone", () => {
    expect(needsWorkspaceBasenameLookup("/usr/local/bin/tool")).toBe(false);
    expect(needsWorkspaceBasenameLookup("C:\\Users\\me\\notes.md")).toBe(false);
    expect(needsWorkspaceBasenameLookup("~/notes/today.md")).toBe(false);
    expect(needsWorkspaceBasenameLookup("   ")).toBe(false);
  });
});

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

describe("pickWorkspaceRelativeMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceRelativeMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("ignores directories", () => {
    expect(
      pickWorkspaceRelativeMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceRelativeMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceRelativeMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceRelativeMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("returns null when nothing matches the name", () => {
    expect(pickWorkspaceRelativeMatch("ChatView.tsx", [])).toBeNull();
    expect(
      pickWorkspaceRelativeMatch("ChatView.tsx", [
        { path: "apps/web/src/components/ChatHeader.tsx", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("resolves a nested relative path when the suffix match is unique", () => {
    expect(
      pickWorkspaceRelativeMatch("Tests/Architecture/README.md", [
        { path: "docs/README.md", kind: "file" },
        { path: "Tests/Architecture/README.md", kind: "file" },
      ]),
    ).toBe("Tests/Architecture/README.md");
    expect(
      pickWorkspaceRelativeMatch("Tests/Architecture/README.md", [
        { path: "Tests/Architecture/README.md", kind: "file" },
      ]),
    ).toBe("Tests/Architecture/README.md");
    // A deeper indexed path still ends with the requested suffix.
    expect(
      pickWorkspaceRelativeMatch("src/README.md", [
        { path: "packages/app/src/README.md", kind: "file" },
      ]),
    ).toBe("packages/app/src/README.md");
  });

  it("does not resolve a nested relative path when the suffix is ambiguous", () => {
    expect(
      pickWorkspaceRelativeMatch("src/README.md", [
        { path: "apps/a/src/README.md", kind: "file" },
        { path: "apps/b/src/README.md", kind: "file" },
      ]),
    ).toBeNull();
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

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    // The older lookup answering last must not reopen the panel behind the
    // newer one.
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("stays valid while it is the only claim", () => {
    const only = claimWorkspaceBasenameLookup();
    expect(only()).toBe(true);
  });
});
