/**
 * The `documents:write` rule (design §3.5): lineage decides, not role. Role,
 * plan identity and grant arrive through one port, so the board's plan record
 * and the mail task supply them without this package knowing either.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Service from "./service.ts";

/** What the rule needs beside lineage, supplied by the plan record and the mail task. */
export interface DocumentsWriteFacts {
  /** Role the thread runs as; null while no role is assigned. */
  readonly role: string | null;
  /** Stable id of the plan document of this planner's card; null without one. */
  readonly planStableId: string | null;
  /** The lead's explicit `documents:write` grant to a `general` participant. */
  readonly granted: boolean;
}

/** Port of those facts; the default has no role, no plan identity and no grant. */
export class DocumentsWriteFactsPort extends Context.Service<
  DocumentsWriteFactsPort,
  {
    readonly factsOf: (
      caller: Service.DocsCaller,
    ) => Effect.Effect<DocumentsWriteFacts, never, never>;
  }
>()("@t3tools/ft3-docs/writeRule/DocumentsWriteFactsPort") {}

const noFacts: DocumentsWriteFacts = { role: null, planStableId: null, granted: false };

/** Every delegated child reads until the plan record or the mail task says otherwise. */
export const noDocumentsWriteFacts: Layer.Layer<DocumentsWriteFactsPort> = Layer.succeed(
  DocumentsWriteFactsPort,
  DocumentsWriteFactsPort.of({
    factsOf: Effect.fn("DocumentsWriteFactsPort.none")(() => Effect.succeed(noFacts)),
  }),
);

/**
 * The rule itself. A caller without a thread is not a top-level thread, so it
 * has no write right either.
 */
export const resolveDocumentsWrite = (
  caller: Service.DocsCaller,
  facts: DocumentsWriteFacts,
): Service.DocumentsWriteDecision => {
  if (caller.threadId === null) {
    return { _tag: "Deny", reason: "no_caller_thread" };
  }
  if (caller.parentThreadId === null) {
    return { _tag: "Allow", scope: "store", reason: "top_level_thread" };
  }
  if (facts.role === "planner" || facts.planStableId !== null) {
    return facts.planStableId === null
      ? { _tag: "Deny", reason: "planner_plan_unknown" }
      : {
          _tag: "Allow",
          scope: "document",
          stableId: facts.planStableId,
          reason: "planner_plan",
        };
  }
  if (facts.role === "general") {
    return facts.granted
      ? { _tag: "Allow", scope: "store", reason: "granted_general" }
      : { _tag: "Deny", reason: "general_without_grant" };
  }
  return { _tag: "Deny", reason: "child_read_only" };
};

/** The rule over a facts port; the host supplies the plan record and the mail task. */
export const documentsWriteAccessLayer: Layer.Layer<
  Service.DocumentsWriteAccess,
  never,
  DocumentsWriteFactsPort
> = Layer.effect(
  Service.DocumentsWriteAccess,
  Effect.map(DocumentsWriteFactsPort, (port) =>
    Service.DocumentsWriteAccess.of({
      decide: Effect.fn("DocumentsWriteAccess.lineage")((caller: Service.DocsCaller) =>
        port.factsOf(caller).pipe(Effect.map((facts) => resolveDocumentsWrite(caller, facts))),
      ),
    }),
  ),
);

/** The rule with no role, plan identity or grant: only top-level threads write. */
export const lineageDocumentsWrite: Layer.Layer<Service.DocumentsWriteAccess> =
  documentsWriteAccessLayer.pipe(Layer.provide(noDocumentsWriteFacts));
