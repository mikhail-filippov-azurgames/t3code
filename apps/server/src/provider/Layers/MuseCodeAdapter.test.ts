import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  museChoiceForDecision,
  museEffortForSelection,
  parseMuseEffort,
} from "./MuseCodeAdapter.ts";

describe("parseMuseEffort", () => {
  it("accepts the offered tiers and stays empty when absent", () => {
    expect(parseMuseEffort(undefined)).toBeUndefined();
    expect(parseMuseEffort("high")).toBe("high");
    expect(parseMuseEffort("xhigh")).toBe("xhigh");
  });

  it("rejects tiers outside the offered set", () => {
    expect(parseMuseEffort("ultra")).toBeUndefined();
    expect(parseMuseEffort("")).toBeUndefined();
  });
});

describe("museEffortForSelection", () => {
  it("reads the reasoningEffort option", () => {
    const selection = createModelSelection(ProviderInstanceId.make("museCode"), "muse-spark-1.3", [
      { id: "reasoningEffort", value: "low" },
    ]);

    expect(museEffortForSelection(selection)).toEqual({ raw: "low", effort: "low" });
  });

  it("reports unknown values for explicit rejection", () => {
    const selection = createModelSelection(ProviderInstanceId.make("museCode"), "muse-spark-1.3", [
      { id: "reasoningEffort", value: "ultra" },
    ]);

    expect(museEffortForSelection(selection)).toEqual({ raw: "ultra", effort: undefined });
    expect(museEffortForSelection(undefined)).toEqual({ raw: undefined, effort: undefined });
  });
});

const CHOICES = [
  { choiceId: "approve", decision: "approved", scope: "once" },
  { choiceId: "approve-session", decision: "approvedForSession", scope: "session" },
  { choiceId: "deny", decision: "denied", scope: "once" },
] as const;

describe("museChoiceForDecision", () => {
  it("maps accept onto the one-shot approval", () => {
    expect(museChoiceForDecision("accept", [...CHOICES])).toBe("approve");
  });

  it("maps acceptForSession onto the session approval", () => {
    expect(museChoiceForDecision("acceptForSession", [...CHOICES])).toBe("approve-session");
  });

  it("maps decline onto the denial", () => {
    expect(museChoiceForDecision("decline", [...CHOICES])).toBe("deny");
  });

  it("maps cancel onto abort when offered, denial otherwise", () => {
    expect(
      museChoiceForDecision("cancel", [
        ...CHOICES,
        { choiceId: "abort", decision: "abort", scope: "once" },
      ]),
    ).toBe("abort");
    expect(museChoiceForDecision("cancel", [...CHOICES])).toBe("deny");
  });

  it("returns undefined when nothing matches", () => {
    expect(museChoiceForDecision("accept", [])).toBeUndefined();
    expect(
      museChoiceForDecision("accept", [{ choiceId: "deny", decision: "denied", scope: "once" }]),
    ).toBeUndefined();
  });
});
