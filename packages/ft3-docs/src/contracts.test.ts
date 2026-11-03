import { describe, expect, it } from "@effect/vitest";

import { parseDocRef } from "./contracts.ts";

// The repository never carries real document ids; tests use the nil UUID.
const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("parseDocRef", () => {
  it("parses an oc document link", () => {
    expect(parseDocRef(`oc://doc/${NIL_ID}`)).toEqual({ kind: "id", stableId: NIL_ID });
  });

  it("parses an ocl document link as the same address", () => {
    expect(parseDocRef(`ocl://doc/${NIL_ID}`)).toEqual({ kind: "id", stableId: NIL_ID });
  });

  it("keeps the revision label of a link", () => {
    expect(parseDocRef(`oc://doc/${NIL_ID}@2`)).toEqual({
      kind: "id",
      stableId: NIL_ID,
      revision: 2,
    });
  });

  it("accepts an upper-case scheme and a trailing slash", () => {
    expect(parseDocRef(`OC://DOC/${NIL_ID}/`)).toEqual({ kind: "id", stableId: NIL_ID });
  });

  it("parses a store-relative path", () => {
    expect(parseDocRef("projects/alpha/plan.md")).toEqual({
      kind: "path",
      relPath: "projects/alpha/plan.md",
    });
  });

  it("normalizes Windows separators and a leading ./", () => {
    expect(parseDocRef(".\\projects\\alpha\\plan.md")).toEqual({
      kind: "path",
      relPath: "projects/alpha/plan.md",
    });
  });

  it("keeps @N in a path as part of the file name", () => {
    expect(parseDocRef("projects/alpha/plan@2.md")).toEqual({
      kind: "path",
      relPath: "projects/alpha/plan@2.md",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseDocRef("  notes/plan.md  ")).toEqual({ kind: "path", relPath: "notes/plan.md" });
  });

  it("rejects a malformed document link", () => {
    expect(parseDocRef("oc://doc/")).toBeNull();
    expect(parseDocRef(`oc://doc/${NIL_ID}?tab=body`)).toBeNull();
    expect(parseDocRef("oc:doc/plan.md")).toBeNull();
  });

  it("rejects a zero, negative, or unsafe revision label", () => {
    expect(parseDocRef(`oc://doc/${NIL_ID}@0`)).toBeNull();
    expect(parseDocRef(`oc://doc/${NIL_ID}@-1`)).toBeNull();
    expect(parseDocRef(`oc://doc/${NIL_ID}@99999999999999999999`)).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(parseDocRef("/projects/alpha/plan.md")).toBeNull();
    expect(parseDocRef("C:\\projects\\alpha\\plan.md")).toBeNull();
    expect(parseDocRef("~/plan.md")).toBeNull();
  });

  it("rejects parent traversal", () => {
    expect(parseDocRef("../plan.md")).toBeNull();
    expect(parseDocRef("projects/../plan.md")).toBeNull();
  });

  it("rejects empty segments and a trailing separator", () => {
    expect(parseDocRef("projects//plan.md")).toBeNull();
    expect(parseDocRef("projects/")).toBeNull();
  });

  it("rejects an empty reference and an external URL", () => {
    expect(parseDocRef("   ")).toBeNull();
    expect(parseDocRef("https://example.test/plan.md")).toBeNull();
  });
});
