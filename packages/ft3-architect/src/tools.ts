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

const getCoordinatorBinding = Tool.make("get_coordinator_binding", {
  description:
    "Read the active architect binding for a coordinator thread. Visible to the coordinator itself, a human on it, or the bound architect (own binding only).",
  parameters: Contracts.ArchitectGetCoordinatorBindingInput,
  success: Contracts.ArchitectGetCoordinatorBindingResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get coordinator binding")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const listArchitectureReviews = Tool.make("list_architecture_reviews", {
  description:
    "List architecture reviews for a coordinator thread, optionally filtered by status. Visible to the coordinator itself, a human on it, or the bound architect (own reviews only).",
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
    "Create this coordinator thread's architect advisor, or return the existing active binding (a repeat create is idempotent). The architect is a read-only advisory sibling, never an executor. Reuse the same idempotencyKey only for an exact retry.",
  parameters: Contracts.ArchitectCreateOrGetInput,
  success: Contracts.ArchitectCreateOrGetResult,
  failure: Contracts.ArchitectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create or get coordinator architect")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const toolkit = Toolkit.make(
  getCoordinatorBinding,
  listArchitectureReviews,
  architectCreateOrGet,
);
