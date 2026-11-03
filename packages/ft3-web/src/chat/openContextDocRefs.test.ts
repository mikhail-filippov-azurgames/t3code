import { describe, expect, it } from "vite-plus/test";

import {
  openContextDocRefFromInlineCode,
  openContextDocTextSegments,
} from "./openContextDocRefs.ts";

const STABLE_ID = "fe000000-0000-4000-8000-000000000004";

describe("openContextDocTextSegments", () => {
  it("isolates a bare reference in prose and keeps the surrounding text", () => {
    expect(openContextDocTextSegments(`See oc://doc/${STABLE_ID} now`)).toEqual([
      { text: "See ", doc: null },
      { text: `oc://doc/${STABLE_ID}`, doc: expect.objectContaining({ stableId: STABLE_ID }) },
      { text: " now", doc: null },
    ]);
  });

  it("canonicalizes a cloud reference and keeps its revision out of the stable id", () => {
    const segments = openContextDocTextSegments(`OCL://DOC/${STABLE_ID}@3/`);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.doc).toEqual({
      href: `ocl://doc/${STABLE_ID}@3`,
      scheme: "ocl",
      stableId: STABLE_ID,
    });
  });

  it("keeps trailing sentence punctuation out of the chip", () => {
    expect(openContextDocTextSegments(`(see oc://doc/${STABLE_ID}).`)).toEqual([
      { text: "(see ", doc: null },
      { text: `oc://doc/${STABLE_ID}`, doc: expect.objectContaining({ stableId: STABLE_ID }) },
      { text: ").", doc: null },
    ]);
  });

  it.each([
    ["oc://doc/a/b"],
    ["oc://doc/a?query=1"],
    ["oc://doc/a#fragment"],
    ["oc://doc/a@0"],
    ["oc://doc/"],
    ["https://example.com/oc://doc/abc"],
    ["xoc://doc/abc"],
  ])("leaves %s plain", (text) => {
    expect(openContextDocTextSegments(text)).toEqual([{ text, doc: null }]);
  });

  it("finds every reference without merging the prose between them", () => {
    const segments = openContextDocTextSegments(`oc://doc/${STABLE_ID} and ocl://doc/other-token`);

    expect(segments.map((segment) => segment.doc?.stableId ?? segment.text)).toEqual([
      STABLE_ID,
      " and ",
      "other-token",
    ]);
  });
});

describe("openContextDocRefFromInlineCode", () => {
  it.each([`oc://doc/${STABLE_ID}`, ` oc://doc/${STABLE_ID}@2 `, `ocl://doc/${STABLE_ID}/`])(
    "reads %s as one reference",
    (text) => {
      expect(openContextDocRefFromInlineCode(text)).toEqual(
        expect.objectContaining({ stableId: STABLE_ID }),
      );
    },
  );

  it.each([
    [`curl oc://doc/${STABLE_ID}`],
    ["oc://doc/a/b"],
    ["oc://doc/"],
    [`oc://doc/${STABLE_ID}\nnext`],
    ["plain code"],
  ])("keeps %s as code", (text) => {
    expect(openContextDocRefFromInlineCode(text)).toBeNull();
  });
});
