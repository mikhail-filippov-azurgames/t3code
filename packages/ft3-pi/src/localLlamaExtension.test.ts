import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "../../provider-pi/src/server/mcpExtensionSource.ts";
import { loadMcpBridge } from "../../provider-pi/src/server/mcpBridge.testkit.ts";
import { PI_BUNDLED_PROVIDER_ID, PI_BUILT_IN_TOOLS } from "./agentDir.ts";
import { applyLocalLlamaExtensionPolicy } from "./localLlamaExtension.ts";

const source = () => applyLocalLlamaExtensionPolicy(PI_T3_MCP_EXTENSION_SOURCE);

describe("Pi local llama extension policy", () => {
  it("keeps the production built-in tool manifest for local llama models", async () => {
    // Captured from the real prepare_coordinator_publication tools/list schema
    // in the failing V2 request. Its summary.maxLength is rejected by llama.cpp.
    const prepareCoordinatorPublicationSchema = {
      type: "object",
      properties: {
        summary: { type: "string", maxLength: 2000 },
        disposition: {
          type: "string",
          enum: ["recommendation", "needs-human-decision", "needs-more-evidence"],
        },
        oclRefs: {
          anyOf: [{ type: "array", items: { type: "string" }, maxItems: 32 }, { type: "null" }],
        },
        executionPosture: {
          type: "string",
          enum: ["continue", "pause-branch", "pause-all"],
        },
        idempotencyKey: { type: "string" },
      },
      required: ["summary", "disposition", "executionPosture", "idempotencyKey"],
      additionalProperties: true,
    };
    const blockedToolName = "mcp__t3-code__delegate_task";
    const bridge = await loadMcpBridge({
      inputSchema: prepareCoordinatorPublicationSchema,
      source: source(),
    });
    bridge.restoreActiveTools([...PI_BUILT_IN_TOOLS, blockedToolName]);
    const registered = bridge.tools.find((tool) => tool.name === blockedToolName);
    assert.deepEqual(registered?.parameters, prepareCoordinatorPublicationSchema);

    const context = {
      model: { api: "openai-completions", provider: PI_BUNDLED_PROVIDER_ID },
      ui: { notify: assert.fail },
    };
    const reconcile = bridge.handlers.get("model_select")!;
    await reconcile({ systemPrompt: "base" }, context);
    assert.deepEqual(bridge.getActiveTools(), [...PI_BUILT_IN_TOOLS]);

    const promptHook = bridge.handlers.get("before_agent_start")!;
    const systemPromptOptions: { sections: Record<string, string> } = {
      sections: { t3_code_orchestration: "stale MCP guidance" },
    };
    const result = await promptHook({ systemPrompt: "base", systemPromptOptions }, context);
    assert.isUndefined(result);
    assert.deepEqual(systemPromptOptions.sections, {});
  });

  it("restores the MCP tools after switching from local to a remote provider", async () => {
    const bridge = await loadMcpBridge({ source: source() });
    bridge.restoreActiveTools([...PI_BUILT_IN_TOOLS]);
    const reconcile = bridge.handlers.get("model_select")!;
    await reconcile(
      { systemPrompt: "base" },
      {
        model: { api: "openai-completions", provider: PI_BUNDLED_PROVIDER_ID },
        ui: { notify: assert.fail },
      },
    );
    await reconcile(
      { systemPrompt: "base" },
      { model: { api: "openai-completions", provider: "openrouter" }, ui: { notify: assert.fail } },
    );
    // Legacy Pi activates bridge tools as they register, without MCP exposure.
    assert.deepEqual(bridge.getActiveTools(), [
      ...PI_BUILT_IN_TOOLS,
      "mcp__t3-code__orchestrator_capabilities",
      "mcp__t3-code__delegate_task",
      "mcp__t3-code__task_status",
      "mcp__t3-code__preview_snapshot",
    ]);
  });
});
