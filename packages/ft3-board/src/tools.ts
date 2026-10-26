import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as BoardService from "./BoardService.ts";
import * as Contracts from "./contracts.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  BoardService.BoardService,
  ThreadManagement.ThreadManagementService,
];
const boardCreateCard = Tool.make("board_create_card", {
  description:
    "Create a kanban card owned by this Coordinator thread. The stored createdBy value remains orchestrator. The status value orchestrator is the Coordinator-owned plan-first state (alongside todo) and is the default. The status value backlog marks a card the human deliberately deferred; use it only when the human asks. The card is created and a system progress-history entry is appended without an LLM call. There is no idempotency key: a repeated call creates another card.",
  parameters: Contracts.BoardCreateCardInput,
  success: Contracts.BoardCard,
  failure: Contracts.BoardMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const boardListCards = Tool.make("board_list_cards", {
  description:
    "List every card owned by this Coordinator thread with its readiness and readinessNote fields. The list is a pointer, not the content: entries carry every card field except the body, plus a bodyChars size hint, and never progress history. Before delegating work, before deciding a card already covers the work, and before accepting a review, read the bodies of the relevant cards through cardIds. Pass up to 10 cardIds to read those own cards whole with their full bodies, in request order; ids of missing or foreign-owned cards land in notFound instead of failing the read. Beyond 64 KB only an order-preserving prefix is returned, with truncated true and omittedCount. Cards are never returned across Coordinator ownership. Archived cards are excluded by default so the archive does not grow the working context; pass includeArchived true to see them, for example to return a card from the archive.",
  parameters: Contracts.BoardListCardsInput,
  success: Contracts.BoardListCardsResult,
  failure: Contracts.BoardMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List board cards")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const boardUpdateCard = Tool.make("board_update_card", {
  description:
    "Update one card owned by this Coordinator thread. Only the calling Coordinator's cards are reachable; another Coordinator's card is reported as not found. A change to status, executor, readiness, or readinessNote appends system progress history. Omitted fields are left unchanged. readiness is parallel to status: ready means work can move; needs_human means an exact human question or decision is required; blocked means an external cause prevents progress. Every non-ready value needs a readinessNote, and done requires readiness=ready. If work is no longer needed, set status to done and outcome to cancelled, preserve the existing body, and append `Closure reason: <why>` so a reader can see why it was closed. For blocked, either fix the cause now and set ready, hand it to the human as needs_human with the exact question, or keep it blocked only while the named awaited work is still running. Do not use Backlog to mark waiting for a human. Moving a card to in_progress requires both assignee and executorThreadId (the delegated child thread); otherwise the call fails with executor_required. Archiving (archived true) works only for done cards and fails with archive_requires_done otherwise; returning a card from the archive (archived false) works for any own card.",
  parameters: Contracts.BoardUpdateCardInput,
  success: Contracts.BoardCard,
  failure: Contracts.BoardMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const boardDeleteCard = Tool.make("board_delete_card", {
  description:
    "Delete one card owned by this Coordinator thread. Another Coordinator's card is reported as not found. The card's progress history is deleted with it.",
  parameters: Contracts.BoardDeleteCardInput,
  success: Schema.Struct({}),
  failure: Contracts.BoardMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete board card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const toolkit = Toolkit.make(
  boardCreateCard,
  boardListCards,
  boardUpdateCard,
  boardDeleteCard,
);
