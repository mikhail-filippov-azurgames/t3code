import { describe, expect, it } from "vite-plus/test";

import { openContextDocMenuItems, parseOpenContextDocHref } from "./openContextDocLink";

describe("open context document links", () => {
  it.each([
    ["oc://doc/fe000000-0000-4000-8000-000000000004", "oc", "fe000000-0000-4000-8000-000000000004"],
    [
      "oc://doc/fe000000-0000-4000-8000-000000000004/",
      "oc",
      "fe000000-0000-4000-8000-000000000004",
    ],
    ["OC://DOC/plain-token", "oc", "plain-token"],
    [
      "ocl://doc/fe000000-0000-4000-8000-000000000004",
      "ocl",
      "fe000000-0000-4000-8000-000000000004",
    ],
  ])("parses %s to its stable id", (href, scheme, stableId) => {
    expect(parseOpenContextDocHref(href)).toEqual({
      href: `${scheme}://doc/${stableId}`,
      scheme,
      stableId,
    });
  });

  it("resolves a versioned document link by stable id while preserving its revision for copying", () => {
    expect(parseOpenContextDocHref("oc://doc/fe000000-0000-4000-8000-000000000004@5")).toEqual({
      href: "oc://doc/fe000000-0000-4000-8000-000000000004@5",
      scheme: "oc",
      stableId: "fe000000-0000-4000-8000-000000000004",
    });
  });

  it.each([
    ["oc://doc/", null],
    ["oc://doc/a/b", null],
    ["oc://doc/a?query=1", null],
    ["oc://doc/a@0", null],
    ["oc://doc/a@latest", null],
    ["oc://folder/abc", null],
    ["https://example.com/oc://doc/abc", null],
    ["#fragment", null],
    [undefined, null],
  ])("does not treat %s as a document link", (href, expected) => {
    expect(parseOpenContextDocHref(href)).toBe(expected);
  });

  it("offers open, copy link, the resolved path, and copy path when resolved", () => {
    expect(
      openContextDocMenuItems({
        status: "found",
        canOpenDocument: true,
        displayPath: "agent-engineering-control/notes.md",
      }),
    ).toEqual([
      { id: "open-document", label: "Open document" },
      { id: "copy-link", label: "Copy link", icon: "copy" },
      {
        id: "status",
        label: "agent-engineering-control/notes.md",
        disabled: true,
        separatorBefore: true,
      },
      { id: "copy-document-path", label: "Copy document path", icon: "copy" },
    ]);
  });

  it("disables open but keeps the link copyable when there is no thread", () => {
    const items = openContextDocMenuItems({ status: "found", canOpenDocument: false });
    expect(items).toContainEqual({ id: "open-document", label: "Open document", disabled: true });
    expect(items).toContainEqual({ id: "copy-link", label: "Copy link", icon: "copy" });
    expect(items.some((item) => item.id === "copy-document-path")).toBe(false);
  });

  it.each([
    ["not_found", "Document not found"],
    ["unavailable", "OpenContext store unavailable"],
  ] as const)("surfaces a clear %s state and still copies the link", (status, label) => {
    const items = openContextDocMenuItems({ status, canOpenDocument: true });
    expect(items).toEqual([
      { id: "status", label, disabled: true },
      { id: "copy-link", label: "Copy link", icon: "copy" },
    ]);
  });
});
