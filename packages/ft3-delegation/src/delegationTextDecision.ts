import { applyAuthorTextPolicy } from "./secretTextPolicy.ts";

export type DelegationTextDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Denied"; readonly reason: string };

const DENIED_REASON =
  "The delegated task or title looks like it contains a credential. Remove the sensitive value and try again.";

export function delegationTextDecision(input: {
  readonly task: string;
  readonly title?: string | undefined;
}): DelegationTextDecision {
  try {
    for (const [field, text] of [
      ["prompt", input.task],
      ["title", input.title],
    ] as const) {
      if (text !== undefined && applyAuthorTextPolicy(field, text)._tag === "Rejected") {
        return { _tag: "Denied", reason: DENIED_REASON };
      }
    }
    return { _tag: "Allowed" };
  } catch {
    return { _tag: "Denied", reason: DENIED_REASON };
  }
}
