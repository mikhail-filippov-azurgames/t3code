import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ArchitectService from "./ArchitectService.ts";
import * as Contracts from "./contracts.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ArchitectService.ArchitectService,
  ThreadManagement.ThreadManagementService,
];

const getCoordinatorBinding = Tool.make("get_lead_binding", {
  description:
    "Read the active architect binding for a lead thread. Visible to the lead itself, a human on it, or the bound architect (own binding only).",
  parameters: Contracts.ArchitectGetCoordinatorBindingInput,
  success: Contracts.ArchitectGetCoordinatorBindingResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get lead binding")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const listArchitectureReviews = Tool.make("list_architecture_reviews", {
  description:
    "List architecture reviews for a lead thread, optionally filtered by status. Visible to the lead itself, a human on it, or the bound architect (own reviews only).",
  parameters: Contracts.ArchitectListArchitectureReviewsInput,
  success: Contracts.ArchitectListArchitectureReviewsResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List architecture reviews")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const architectCreateOrGet = Tool.make("architect_create_or_get", {
  description:
    "Create this lead thread's architect advisor, or return the existing active binding (a repeat create is idempotent). The architect is a read-only advisory sibling, never an executor. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectCreateOrGetInput,
  success: Contracts.ArchitectCreateOrGetResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create or get lead architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const architectReplace = Tool.make("architect_replace", {
  description:
    "Permanently replace this lead thread's architect with a fresh thread. The old binding transitions to replaced first, then its credential is revoked. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectReplaceInput,
  success: Contracts.ArchitectReplaceResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Replace lead architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const architectDetach = Tool.make("architect_detach", {
  description:
    "Permanently detach this lead thread's architect. The binding transitions to detached, the credential is revoked, and terminal bindings never restore. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectDetachInput,
  success: Contracts.ArchitectDetachResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Detach lead architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const architectureReviewRequest = Tool.make("architecture_review_request", {
  description:
    "Request an architecture review from the bound architect. executionPosture is required (continue, pause-branch, or pause-all) and is advisory only. The request wakes the architect exactly once; the lead is never woken by a request. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectReviewRequestInput,
  success: Contracts.ArchitectReviewRequestResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request architecture review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const architectureReviewAnswer = Tool.make("architecture_review_answer", {
  description:
    "Answer an architecture review as the bound architect. disposition is required (recommendation, needs-human-decision, or needs-more-evidence). Answers are first-wins and never wake the lead. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectReviewAnswerInput,
  success: Contracts.ArchitectReviewAnswerResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Answer architecture review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const architectureReviewCancel = Tool.make("architecture_review_cancel", {
  description:
    "Cancel an open or answered architecture review as the lead (or a human on it). Cancelling a published review is rejected. Cancellation never wakes anyone. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectReviewCancelInput,
  success: Contracts.ArchitectReviewCancelResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel architecture review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const prepareCoordinatorPublication = Tool.make("prepare_lead_publication", {
  description:
    "Prepare a lead publication as the bound architect. This never wakes the lead; the human publishes it with the Publish button. Replaces the previous unpublished preparation. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectPrepareCoordinatorPublicationInput,
  success: Contracts.ArchitectPrepareCoordinatorPublicationResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Prepare lead publication")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const publishToCoordinator = Tool.make("publish_to_lead", {
  description:
    "Publish an answered review to the lead. This is the only architect-originated lead wake: it fires exactly once per review and carries the stored disposition. Ordinary answers never wake the lead. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectPublishToCoordinatorInput,
  success: Contracts.ArchitectPublishToCoordinatorResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Publish review to lead")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const toolkit = Toolkit.make(
  getCoordinatorBinding,
  listArchitectureReviews,
  architectCreateOrGet,
  architectReplace,
  architectDetach,
  architectureReviewRequest,
  architectureReviewAnswer,
  architectureReviewCancel,
  prepareCoordinatorPublication,
  publishToCoordinator,
);
