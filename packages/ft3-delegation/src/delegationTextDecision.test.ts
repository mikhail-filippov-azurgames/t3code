import { describe, expect, it } from "@effect/vitest";

import { delegationTextDecision } from "./delegationTextDecision.ts";

const providerToken = `ghp_${"A".repeat(32)}`;

describe("delegationTextDecision", () => {
  it("allows a clean task and title", () => {
    expect(
      delegationTextDecision({
        task: "Summarize the parser changes and list the risks.",
        title: "Parser review",
      }),
    ).toEqual({ _tag: "Allowed" });
  });

  it("denies a task that contains a credential", () => {
    const decision = delegationTextDecision({ task: `Use ${providerToken} for access.` });

    expect(decision._tag).toBe("Denied");
    expect(JSON.stringify(decision)).not.toContain(providerToken);
  });

  it("denies a title that contains a credential", () => {
    const decision = delegationTextDecision({
      task: "Summarize the parser changes.",
      title: `Incident ${providerToken}`,
    });

    expect(decision._tag).toBe("Denied");
    expect(JSON.stringify(decision)).not.toContain(providerToken);
  });
});
