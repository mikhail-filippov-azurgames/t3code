import { describe, expect, it } from "vite-plus/test";
import { BoardMcpFailure } from "@t3tools/ft3-board/contracts";

import { planAcceptAvailable, planFailureView } from "./planViewer.logic.ts";

describe("planAcceptAvailable", () => {
  it.each([
    ["required", false],
    ["drafting", false],
    ["reviewing", false],
    ["discussion", true],
    ["accepted", false],
    ["withdrawn", false],
  ] as const)("is %s available for acceptance: %s", (state, expected) => {
    expect(planAcceptAvailable(state)).toBe(expected);
  });

  it("stays unavailable while the state is unknown", () => {
    expect(planAcceptAvailable(null)).toBe(false);
  });
});

describe("planFailureView", () => {
  it("marks plan_changed and keeps the server message", () => {
    const view = planFailureView(
      new BoardMcpFailure({ code: "plan_changed", message: "Plan changed; read it again." }),
    );
    expect(view.changed).toBe(true);
    expect(view.text).toBe("Plan changed; read it again.");
  });

  it("keeps plan_invalid readable without the reload mark", () => {
    const view = planFailureView(
      new BoardMcpFailure({
        code: "invalid_request",
        message:
          'Plan for card "c" line 4: step ids must be unique. Fix the plan and accept again.',
      }),
    );
    expect(view.changed).toBe(false);
    expect(view.text).toContain("line 4");
  });

  it("falls back for non-board failures", () => {
    expect(planFailureView(new Error("offline")).text).toBe("offline");
    expect(planFailureView("weird").text).toBe("Could not accept the plan.");
  });
});
