import { PI_BUNDLED_PROVIDER_ID, PI_BUILT_IN_TOOLS } from "./agentDir.ts";

const BUILTIN_SET_ANCHOR = 'const PROTOCOL = "2025-06-18";';
const BUILTIN_SET_DECLARATION = `
const LOCAL_LLAMA_BUILTIN_TOOLS = new Set(${JSON.stringify(PI_BUILT_IN_TOOLS)});`;

// Keep the production Pi manifest for local llama models: llama.cpp's grammar
// compiler rejects some T3 MCP JSON schemas.
const RECONCILE_ANCHOR = `  const reconcileDiscovery = (ctx: Pick<ExtensionContext, "model">) => {
    if (!supportsExposure) return;`;
const RECONCILE_REPLACEMENT = `  const reconcileDiscovery = (ctx: Pick<ExtensionContext, "model">) => {
    const active = pi.getActiveTools();
    if (ctx.model?.provider === ${JSON.stringify(PI_BUNDLED_PROVIDER_ID)}) {
      const builtins = active.filter((name) => LOCAL_LLAMA_BUILTIN_TOOLS.has(name));
      if (builtins.length !== active.length) pi.setActiveTools(builtins);
      return;
    }
    if (!supportsExposure) {
      // Legacy Pi activates custom tools as they register; restore them when a
      // session switches from local back to a remote provider.
      const required = catalog.map((tool) => "mcp__t3-code__" + tool.name);
      const missing = required.filter((name) => !active.includes(name));
      if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
      return;
    }`;

const ACTIVE_TOOLS_ANCHOR = `    if (exposureChanged) registerTools();
    const active = pi.getActiveTools();`;
const ACTIVE_TOOLS_REPLACEMENT = "    if (exposureChanged) registerTools();";

const PROMPT_ANCHOR = `    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {`;
const PROMPT_REPLACEMENT = `    const sections = event.systemPromptOptions?.sections;
    if (ctx.model?.provider === ${JSON.stringify(PI_BUNDLED_PROVIDER_ID)}) {
      if (sections && typeof sections === "object") delete sections.t3_code_orchestration;
      return undefined;
    }
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {`;

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const index = source.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Pi extension source no longer contains: ${anchor.split("\n")[0]}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

export function applyLocalLlamaExtensionPolicy(source: string): string {
  return replaceOnce(
    replaceOnce(
      replaceOnce(
        replaceOnce(source, BUILTIN_SET_ANCHOR, BUILTIN_SET_ANCHOR + BUILTIN_SET_DECLARATION),
        RECONCILE_ANCHOR,
        RECONCILE_REPLACEMENT,
      ),
      ACTIVE_TOOLS_ANCHOR,
      ACTIVE_TOOLS_REPLACEMENT,
    ),
    PROMPT_ANCHOR,
    PROMPT_REPLACEMENT,
  );
}
