// @effect-diagnostics nodeBuiltinImport:off - assets/plan-template.md is the source the embedded copy must match.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { PLAN_TEMPLATE } from "./planTemplate.ts";

const assetPath = NodePath.join(
  NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  "assets",
  "plan-template.md",
);

describe("embedded plan template", () => {
  it("embeds assets/plan-template.md with identical content", () => {
    expect(PLAN_TEMPLATE).toBe(NodeFS.readFileSync(assetPath, "utf8"));
  });
});
