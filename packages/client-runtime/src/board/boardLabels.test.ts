import { EXECUTOR_ROLES, type BoardExecutorRole } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { boardExecutorRoleLabel } from "./boardLabels.ts";

describe("boardExecutorRoleLabel", () => {
  it("labels every executor role the contract defines", () => {
    for (const role of EXECUTOR_ROLES) {
      assert.isTrue(boardExecutorRoleLabel(role).length > 0);
    }
  });

  it("keeps the canonical web copy", () => {
    const expected: Readonly<Record<BoardExecutorRole, string>> = {
      architecture: "Architecture",
      implementation: "Implementation",
      review: "Review",
      test: "Test",
      research: "Research",
      general: "General",
    };
    for (const role of EXECUTOR_ROLES) {
      assert.strictEqual(boardExecutorRoleLabel(role), expected[role]);
    }
  });
});
