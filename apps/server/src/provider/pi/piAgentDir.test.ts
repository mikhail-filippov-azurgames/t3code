import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  PI_BUNDLED_PROVIDER_ID,
  buildPiModelsJson,
  buildPiSettingsJson,
  normalizePiApiKey,
  normalizePiBaseUrl,
  normalizePiModelSlug,
  resolvePiManagedModels,
} from "./piAgentDir.ts";

describe("pi agent dir", () => {
  it("falls back to loopback Ollama URL and dummy key", () => {
    NodeAssert.equal(normalizePiBaseUrl("  "), "http://127.0.0.1:11434/v1");
    NodeAssert.equal(normalizePiApiKey(""), "ollama");
    NodeAssert.equal(normalizePiBaseUrl("http://lan:11434/v1"), "http://lan:11434/v1");
  });

  it("qualifies endpoint IDs for Pi without inventing a model", () => {
    NodeAssert.equal(normalizePiModelSlug("qwen2.5-coder:7b"), "ft3-local/qwen2.5-coder:7b");
    NodeAssert.equal(
      normalizePiModelSlug("ft3-local/qwen2.5-coder:7b"),
      "ft3-local/qwen2.5-coder:7b",
    );
    NodeAssert.equal(normalizePiModelSlug(" "), undefined);
  });

  it("writes a single ft3-local OpenAI-compatible provider", () => {
    const parsed = JSON.parse(
      buildPiModelsJson({ baseUrl: "", apiKey: "", models: ["qwen2.5-coder:7b"] }),
    ) as {
      providers: Record<
        string,
        { baseUrl: string; api: string; apiKey: string; models: Array<{ id: string }> }
      >;
    };
    NodeAssert.deepEqual(Object.keys(parsed.providers), [PI_BUNDLED_PROVIDER_ID]);
    NodeAssert.equal(parsed.providers[PI_BUNDLED_PROVIDER_ID]?.api, "openai-completions");
    NodeAssert.equal(
      parsed.providers[PI_BUNDLED_PROVIDER_ID]?.baseUrl,
      "http://127.0.0.1:11434/v1",
    );
    NodeAssert.equal(parsed.providers[PI_BUNDLED_PROVIDER_ID]?.apiKey, "ollama");
  });

  it("dedupes configured models and leaves the list empty when none are configured", () => {
    const parsed = JSON.parse(
      buildPiModelsJson({ baseUrl: "http://x/v1", apiKey: "k", models: [] }),
    ) as { providers: Record<string, { models: Array<{ id: string }> }> };
    NodeAssert.deepEqual(parsed.providers[PI_BUNDLED_PROVIDER_ID]?.models, []);
    NodeAssert.deepEqual(
      resolvePiManagedModels({ configuredModel: " a ", customModels: ["a", "b"] }),
      ["a", "b"],
    );
  });

  it("does not write a default model when no model was configured", () => {
    const settings = JSON.parse(buildPiSettingsJson({ runtimeMode: "approval-required" })) as {
      defaultModel?: string;
    };
    NodeAssert.equal(settings.defaultModel, undefined);
  });

  it("does not double-qualify the default model when given a Pi model slug", () => {
    const settings = JSON.parse(
      buildPiSettingsJson({
        runtimeMode: "approval-required",
        defaultModel: "ft3-local/bonsai-2-27b",
      }),
    ) as { defaultModel: string };
    NodeAssert.equal(settings.defaultModel, "ft3-local/bonsai-2-27b");
  });

  it("pins tools per runtime mode and never trusts projects", () => {
    const locked = JSON.parse(buildPiSettingsJson({ runtimeMode: "approval-required" })) as {
      defaultTools: Array<string>;
      defaultProjectTrust: string;
    };
    NodeAssert.ok(!locked.defaultTools.includes("bash"));
    NodeAssert.equal(locked.defaultProjectTrust, "never");
    const full = JSON.parse(
      buildPiSettingsJson({ runtimeMode: "full-access", defaultModel: "qwen2.5-coder:7b" }),
    ) as { defaultTools: Array<string>; defaultModel: string };
    NodeAssert.ok(full.defaultTools.includes("bash"));
    NodeAssert.equal(full.defaultModel, "ft3-local/qwen2.5-coder:7b");
  });
});
