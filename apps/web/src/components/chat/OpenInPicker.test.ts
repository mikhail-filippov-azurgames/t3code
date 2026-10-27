import { FolderClosedIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { REMOTE_CAPABLE_EDITOR_IDS, buildRemoteOpenUrl } from "@t3tools/contracts";
import { resolvePreferredEditor } from "../../editorPreferences";
import { FileExplorerIcon, FinderIcon, TyporaIcon } from "../Icons";
import { resolveOpenInOptions } from "./OpenInPicker";

describe("resolveOpenInOptions", () => {
  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when unavailable or using remote editors", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });

  it("includes Typora only when the server discovered it", () => {
    expect(resolveOpenInOptions("Win32", ["typora", "vscode"])).toEqual([
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({
        value: "typora",
        label: "Typora",
        Icon: TyporaIcon,
        kind: "brand",
      }),
    ]);
    expect(resolveOpenInOptions("Win32", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
  });

  it("keeps Typora out of remote SSH links", () => {
    expect(REMOTE_CAPABLE_EDITOR_IDS).not.toContain("typora");
    expect(
      buildRemoteOpenUrl({ editor: "typora", host: "sol", absolutePath: "/tmp/readme.md" }),
    ).toBeUndefined();
  });

  it("does not reuse Typora as the preferred editor outside Markdown preview", () => {
    expect(resolvePreferredEditor(["typora", "vscode"], "typora")).toBe("vscode");
    expect(resolvePreferredEditor(["typora"], "typora")).toBeNull();
    expect(resolvePreferredEditor(["typora", "vscode"], "typora", true)).toBe("typora");
  });
});
