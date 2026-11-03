// @effect-diagnostics nodeBuiltinImport:off - assets/ is the readable source the map must match.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { BUILTIN_ASSET_CONTENTS } from "./builtinAssets.ts";

const packageRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const assetFiles = (relativeDirectory: string): ReadonlyArray<string> => {
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(NodePath.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(NodePath.join(packageRoot, relativeDirectory), relativeDirectory);
  return files.sort();
};

describe("embedded built-in assets", () => {
  it("embed every file of assets/ with identical content", () => {
    const onDisk = assetFiles("assets");
    expect(Object.keys(BUILTIN_ASSET_CONTENTS).sort()).toEqual(onDisk);
    for (const relative of onDisk) {
      expect(BUILTIN_ASSET_CONTENTS[relative]).toBe(
        NodeFS.readFileSync(NodePath.join(packageRoot, relative), "utf8"),
      );
    }
  });
});
