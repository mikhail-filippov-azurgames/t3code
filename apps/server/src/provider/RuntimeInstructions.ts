const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const ORCHESTRATION_INSTRUCTIONS = `<orchestration>
The t3-code MCP server exposes durable cross-provider child threads. For complex work with independent roles or parallel tracks, act as a coordinator: call orchestrator_capabilities before choosing an exact target, then use delegate_task and track each child with task_status, task_wait, or task_cancel. Completed children announce themselves as durable messages in the parent thread; do not block in a long task_wait loop, though short bounded waits are fine when joining a child. Keep each child prompt self-contained and synthesize the results in the parent. For small single-owner tasks, work directly. If the t3-orchestrator skill is available, use it for routing and workflow policy when delegation is appropriate.
If an orchestration call fails with parent_not_active, read its [reason=...] token and act on it, never invent an explanation: parent_no_active_turn, parent_turn_mismatch, and parent_turn_not_running are transient, so retry the call once after a short pause and continue the turn if it succeeds; parent_session_instance_changed, parent_scope_drift, parent_thread_gone, and parent_project_gone are final for this turn, so do not retry in a loop and do not create a child thread blindly — finish the current turn yourself and quote the reason token verbatim in your summary.
</orchestration>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly orchestrationAvailable?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const orchestration = runtime.orchestrationAvailable ? `\n\n${ORCHESTRATION_INSTRUCTIONS}` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>${orchestration}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
