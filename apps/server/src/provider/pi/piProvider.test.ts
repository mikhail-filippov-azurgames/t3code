// @effect-diagnostics nodeBuiltinImport:off - Tests use disposable filesystem fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PiSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { describe, it } from "vite-plus/test";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  piDiscoveredModelsToServerModels,
  piModelsFromSettings,
  piProviderProbeStatus,
} from "./piProvider.ts";

describe("pi provider models", () => {
  it("starts without a fake model when no model is configured", () => {
    NodeAssert.deepEqual(piModelsFromSettings(undefined), []);
  });

  it("lists configured custom models without inventing a provider-name model", () => {
    const models = piModelsFromSettings(["custom-a"]);
    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["ft3-local/custom-a"],
    );
    NodeAssert.equal(models[0]?.isCustom, true);
  });

  it("prefers discovered slugs and marks the first default", () => {
    const models = piDiscoveredModelsToServerModels(
      ["ft3-local/qwen2.5-coder:7b", "ft3-local/extra"],
      {
        configuredModel: "",
        customModels: [],
      },
    );
    NodeAssert.equal(models[0]?.slug, "ft3-local/qwen2.5-coder:7b");
    NodeAssert.equal(models[0]?.isDefault, true);
    NodeAssert.equal(models[1]?.isDefault, undefined);
  });

  it("qualifies bare discovered model IDs with Pi's configured provider", () => {
    const models = piDiscoveredModelsToServerModels(["qwen2.5-coder:7b"], {
      configuredModel: "",
      customModels: [],
    });
    NodeAssert.equal(models[0]?.slug, "ft3-local/qwen2.5-coder:7b");
    NodeAssert.equal(models[0]?.isDefault, true);
  });

  it("uses the configured endpoint model without inventing a default", () => {
    const models = piDiscoveredModelsToServerModels([], {
      configuredModel: "qwen2.5-coder:7b",
      customModels: [],
    });
    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["ft3-local/qwen2.5-coder:7b"],
    );
    NodeAssert.equal(models[0]?.isDefault, true);
  });

  it("keeps custom model capabilities when Pi reports the model as discovered", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
    });
    const models = piDiscoveredModelsToServerModels(["ft3-local/custom-a"], {
      configuredModel: "",
      customModels: [{ slug: "custom-a", name: "Custom A", capabilities }],
    });

    NodeAssert.equal(models[0]?.isCustom, true);
    NodeAssert.equal(models[0]?.name, "Custom A");
    NodeAssert.deepEqual(models[0]?.capabilities, capabilities);
  });

  it("reports endpoint readiness independently from the Pi CLI model catalog", () => {
    const cliCatalog = ["ft3-local/qwen2.5-coder:7b"];
    const endpointNotReady = { ready: false, modelIds: cliCatalog };
    const endpointReady = { ready: true, modelIds: cliCatalog };
    NodeAssert.equal(piProviderProbeStatus(endpointNotReady), "warning");
    NodeAssert.equal(piProviderProbeStatus(endpointReady), "ready");
  });
});

effectIt.layer(NodeServices.layer)("checkPiProviderStatus binary availability", (it) => {
  it.effect("keeps the initial Pi snapshot unselectable until the binary check completes", () =>
    Effect.gen(function* () {
      const initial = yield* buildInitialPiProviderSnapshot({
        enabled: true,
        binaryPath: "pi",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "",
        model: "bonsai-2-27b",
        inferenceServerExecutablePath: "",
        inferenceServerModelPath: "",
        inferenceServerProfiles: [],
        inferenceServerAutoStart: false,
        inferenceServerGpuLayers: 48,
        inferenceServerContextSize: 81920,
        inferenceServerParallel: 1,
        inferenceServerTemperature: 1,
        inferenceServerTopP: 0.95,
        inferenceServerTopK: 20,
        inferenceServerMinP: 0.05,
        inferenceServerFlashAttention: true,
        inferenceServerCacheTypeK: "q4_0",
        inferenceServerCacheTypeV: "q4_0",
        inferenceServerJinja: true,
        inferenceServerReasoning: true,
        inferenceServerReasoningEffort: "medium",
        customModels: [],
      });

      NodeAssert.equal(initial.installed, false);
      NodeAssert.equal(initial.status, "warning");
      NodeAssert.match(initial.message ?? "", /Checking bundled Pi runtime/);
    }),
  );

  it.effect("rejects a custom Pi executable as uninstalled and unavailable", () =>
    Effect.gen(function* () {
      const settings: PiSettings = {
        enabled: true,
        binaryPath: "__t3_test_missing_pi_runtime__.exe",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "",
        model: "bonsai-2-27b",
        inferenceServerExecutablePath: "",
        inferenceServerModelPath: "",
        inferenceServerProfiles: [],
        inferenceServerAutoStart: false,
        inferenceServerGpuLayers: 48,
        inferenceServerContextSize: 81920,
        inferenceServerParallel: 1,
        inferenceServerTemperature: 1,
        inferenceServerTopP: 0.95,
        inferenceServerTopK: 20,
        inferenceServerMinP: 0.05,
        inferenceServerFlashAttention: true,
        inferenceServerCacheTypeK: "q4_0",
        inferenceServerCacheTypeV: "q4_0",
        inferenceServerJinja: true,
        inferenceServerReasoning: true,
        inferenceServerReasoningEffort: "medium",
        customModels: [],
      };
      const snapshot = yield* checkPiProviderStatus(settings, { PATH: "" }, process.cwd());

      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.match(snapshot.message ?? "", /custom Pi binaries are not permitted/);
    }),
  );

  it.effect("rejects inherited loader variables before the status probe spawns Pi", () =>
    Effect.gen(function* () {
      let spawnAttempts = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawnAttempts += 1;
        return Effect.die(new Error("unexpected Pi status spawn"));
      });
      const settings: PiSettings = {
        enabled: true,
        binaryPath: "pi",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "",
        model: "bonsai-2-27b",
        inferenceServerExecutablePath: "",
        inferenceServerModelPath: "",
        inferenceServerProfiles: [],
        inferenceServerAutoStart: false,
        inferenceServerGpuLayers: 48,
        inferenceServerContextSize: 81920,
        inferenceServerParallel: 1,
        inferenceServerTemperature: 1,
        inferenceServerTopP: 0.95,
        inferenceServerTopK: 20,
        inferenceServerMinP: 0.05,
        inferenceServerFlashAttention: true,
        inferenceServerCacheTypeK: "q4_0",
        inferenceServerCacheTypeV: "q4_0",
        inferenceServerJinja: true,
        inferenceServerReasoning: true,
        inferenceServerReasoningEffort: "medium",
        customModels: [],
      };
      const snapshot = yield* checkPiProviderStatus(
        settings,
        { PATH: "", DYLD_INSERT_LIBRARIES: "C:/injected/pi-hook.dylib" },
        process.cwd(),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.match(
        snapshot.message ?? "",
        /unsafe environment variable DYLD_INSERT_LIBRARIES/i,
      );
      NodeAssert.equal(spawnAttempts, 0);
    }),
  );

  it.effect("keeps the Pi health probe from replacing a selected session model profile", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-status-probe-"));
    const agentDir = NodePath.join(tempDir, "agent");
    const statusProbeDir = NodePath.join(agentDir, "provider-status");
    NodeFS.mkdirSync(agentDir, { recursive: true });
    const sessionFiles = new Map([
      [
        "models.json",
        '{"providers":{"ft3-local":{"baseUrl":"http://127.0.0.1:8080/v1","models":[{"id":"bonsai-2-27b"}]}}}\n',
      ],
      ["settings.json", '{"defaultModel":"ft3-local/bonsai-2-27b"}\n'],
      ["APPEND_SYSTEM.md", "session-specific instructions\n"],
    ] as const);
    for (const [name, contents] of sessionFiles) {
      NodeFS.writeFileSync(NodePath.join(agentDir, name), contents);
    }
    const settings: PiSettings = {
      enabled: true,
      binaryPath: "__t3_test_custom_pi_status_probe__.exe",
      baseUrl: "http://127.0.0.1:8081/v1",
      apiKey: "status-probe-secret",
      model: "ternary-bonsai-8b",
      inferenceServerExecutablePath: "C:\\fake\\llama-server.exe",
      inferenceServerModelPath: "C:\\fake\\8B.gguf",
      inferenceServerProfiles: [
        {
          model: "ft3-local/bonsai-2-27b",
          baseUrl: "http://127.0.0.1:8080/v1",
          executablePath: "C:\\fake\\llama-server.exe",
          modelPath: "C:\\fake\\27B.gguf",
        },
      ],
      inferenceServerAutoStart: true,
      inferenceServerGpuLayers: 48,
      inferenceServerContextSize: 81920,
      inferenceServerParallel: 1,
      inferenceServerTemperature: 1,
      inferenceServerTopP: 0.95,
      inferenceServerTopK: 20,
      inferenceServerMinP: 0.05,
      inferenceServerFlashAttention: true,
      inferenceServerCacheTypeK: "q4_0",
      inferenceServerCacheTypeV: "q4_0",
      inferenceServerJinja: true,
      inferenceServerReasoning: true,
      inferenceServerReasoningEffort: "medium",
      customModels: [],
    };

    return Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        settings,
        { PATH: "" },
        process.cwd(),
        agentDir,
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.match(snapshot.message ?? "", /custom Pi binaries are not permitted/);
      for (const [name, contents] of sessionFiles) {
        NodeAssert.equal(NodeFS.readFileSync(NodePath.join(agentDir, name), "utf8"), contents);
      }
      NodeAssert.equal(NodeFS.existsSync(statusProbeDir), true);
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(statusProbeDir, "models.json")), false);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
