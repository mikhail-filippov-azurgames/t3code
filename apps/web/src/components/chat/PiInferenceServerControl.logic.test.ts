import * as NodeAssert from "node:assert/strict";

import {
  PiSettings,
  ProviderInstanceId,
  type PiBonsaiPreset,
  type PiInferenceServerStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";

import {
  diffPiSettings,
  applyPiBonsaiPresetToSettings,
  hasUsablePiInferenceProfile,
  isPiBonsai27BModel,
  piInferenceProfileForModel,
  piInferenceServerCanStop,
  piInferenceServerControlVisible,
  piInferenceServerPendingRestart,
  piInferenceServerReadyRefreshKey,
  piInferenceServerStatusLabel,
  piInferenceServerTone,
  resolvePiBonsaiFolderPickerTarget,
} from "./PiInferenceServerControl.logic.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { desktopLocalConnectionId } from "../../connection/desktopLocal";

const baseStatus: PiInferenceServerStatus = {
  instanceId: ProviderInstanceId.make("pi-default"),
  endpoint: "http://127.0.0.1:8080/v1",
  local: true,
  phase: "stopped",
  owner: "none",
  ready: false,
  canStart: true,
  canStop: false,
  pendingRestart: false,
  orphanedManagedEndpoint: null,
  usedByOtherInstances: false,
  progress: null,
  error: null,
  modelIds: [],
};

const environmentId = EnvironmentId.make("pi-folder-picker-test");

describe("Pi inference composer status", () => {
  it("routes the Bonsai folder picker only to desktop primary or WSL filesystems", () => {
    const primary = new PrimaryConnectionTarget({
      environmentId,
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      label: "This device",
    });
    const wsl = new BearerConnectionTarget({
      environmentId,
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
    });
    const remote = new SshConnectionTarget({
      environmentId,
      connectionId: "ssh:remote",
      label: "Remote",
    });

    NodeAssert.equal(
      resolvePiBonsaiFolderPickerTarget(true, primary),
      PRIMARY_LOCAL_ENVIRONMENT_ID,
    );
    NodeAssert.equal(resolvePiBonsaiFolderPickerTarget(true, wsl), "wsl:Ubuntu");
    NodeAssert.equal(resolvePiBonsaiFolderPickerTarget(true, remote), null);
    NodeAssert.equal(resolvePiBonsaiFolderPickerTarget(false, primary), null);
    NodeAssert.equal(resolvePiBonsaiFolderPickerTarget(true, null), null);
  });

  it("applies only the verified 27B preset to its exact model profile", () => {
    const settings = Schema.decodeSync(PiSettings)({
      model: "bonsai-2-8b",
      inferenceServerModelPath: "C:/Bonsai/models/8B/model.gguf",
      inferenceServerProfiles: [
        {
          model: "ft3-local/bonsai-2-8b",
          executablePath: "C:/Bonsai/bin/llama-server.exe",
          modelPath: "C:/Bonsai/models/8B/model.gguf",
          baseUrl: "http://127.0.0.1:8081/v1",
        },
      ],
    });
    const preset: PiBonsaiPreset = {
      executablePath: "C:/Bonsai/bin/llama-server.exe",
      modelPath: "C:/Bonsai/models/27B/model.gguf",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "bonsai-2-27b",
    };

    const updated = applyPiBonsaiPresetToSettings(settings, "ft3-local/bonsai-2-27b", preset);

    NodeAssert.deepEqual(updated.inferenceServerProfiles, [
      settings.inferenceServerProfiles[0],
      {
        model: "ft3-local/bonsai-2-27b",
        executablePath: preset.executablePath,
        modelPath: preset.modelPath,
        baseUrl: preset.baseUrl,
      },
    ]);
    NodeAssert.equal(updated.inferenceServerModelPath, "C:/Bonsai/models/8B/model.gguf");
    NodeAssert.equal(isPiBonsai27BModel("ft3-local/bonsai-2-27b"), true);
    NodeAssert.equal(isPiBonsai27BModel("ft3-local/bonsai-2-8b"), false);
    NodeAssert.throws(
      () => applyPiBonsaiPresetToSettings(settings, "ft3-local/bonsai-2-8b", preset),
      /does not match/,
    );
  });

  it("reuses a saved profile and does not treat stale legacy 8B paths as 27B configuration", () => {
    const settings = Schema.decodeSync(PiSettings)({
      model: "bonsai-2-8b",
      inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
      inferenceServerModelPath: "C:/Bonsai/models/8B/model.gguf",
      inferenceServerProfiles: [
        {
          model: "ft3-local/bonsai-2-27b",
          executablePath: "C:/Bonsai/bin/llama-server.exe",
          modelPath: "C:/Bonsai/models/27B/model.gguf",
          baseUrl: "http://127.0.0.1:8080/v1",
        },
      ],
    });

    const profile = piInferenceProfileForModel(settings, "bonsai-2-27b");
    NodeAssert.equal(hasUsablePiInferenceProfile(profile), true);
    NodeAssert.equal(profile?.modelPath, "C:/Bonsai/models/27B/model.gguf");
    NodeAssert.equal(
      hasUsablePiInferenceProfile(piInferenceProfileForModel(settings, "ft3-local/bonsai-2-8b")),
      false,
    );
  });

  it("sends only fields changed since a settings dialog was opened", () => {
    const base = Schema.decodeSync(PiSettings)({});
    const draft = {
      ...base,
      inferenceServerContextSize: 32768,
      inferenceServerTopP: 0.8,
    };

    NodeAssert.deepEqual(diffPiSettings(base, draft), {
      inferenceServerContextSize: 32768,
      inferenceServerTopP: 0.8,
    });
    NodeAssert.deepEqual(
      diffPiSettings(base, { ...base, customModels: [...base.customModels] }),
      {},
      "equivalent array values are not emitted as stale replacements",
    );
  });

  it("keeps Stop available for an old managed process after the configured endpoint changes", () => {
    const changedEndpoint = {
      ...baseStatus,
      endpoint: "https://api.example.invalid",
      local: false,
      phase: "ready",
      owner: "external",
      ready: true,
      canStart: false,
      orphanedManagedEndpoint: "http://127.0.0.1:8080",
    } satisfies PiInferenceServerStatus;

    NodeAssert.equal(piInferenceServerCanStop(changedEndpoint), true);
    NodeAssert.equal(piInferenceServerControlVisible(changedEndpoint), true);
    NodeAssert.equal(piInferenceServerCanStop(baseStatus), false);
    NodeAssert.equal(piInferenceServerControlVisible({ ...baseStatus, local: false }), false);
  });

  it("shows pending restart only for FT3-owned managed processes", () => {
    NodeAssert.equal(
      piInferenceServerPendingRestart({ ...baseStatus, pendingRestart: true }),
      false,
    );
    NodeAssert.equal(
      piInferenceServerPendingRestart({
        ...baseStatus,
        owner: "ft3",
        canStop: false,
        usedByOtherInstances: true,
        pendingRestart: true,
      }),
      true,
    );
    NodeAssert.equal(
      piInferenceServerPendingRestart({ ...baseStatus, owner: "external", pendingRestart: true }),
      false,
    );
  });

  it("explains shared ownership while keeping the managed process non-stoppable", () => {
    const shared = {
      ...baseStatus,
      phase: "ready",
      owner: "ft3",
      ready: true,
      canStop: false,
      usedByOtherInstances: true,
      pendingRestart: true,
    } satisfies PiInferenceServerStatus;

    NodeAssert.equal(piInferenceServerCanStop(shared), false);
    NodeAssert.equal(piInferenceServerPendingRestart(shared), true);
    NodeAssert.match(piInferenceServerStatusLabel(shared), /shared with another Pi instance/);
  });
  it("maps off, FT3 startup, and ready to the required indicator colors", () => {
    NodeAssert.equal(piInferenceServerTone(null), "off");
    NodeAssert.equal(piInferenceServerTone(baseStatus), "off");
    NodeAssert.equal(
      piInferenceServerTone({
        ...baseStatus,
        phase: "running",
        owner: "ft3",
        canStop: true,
      }),
      "starting",
    );
    NodeAssert.equal(
      piInferenceServerTone({ ...baseStatus, phase: "ready", ready: true }),
      "ready",
    );
  });

  it("describes external ownership and displays only discovered model IDs", () => {
    const status = {
      ...baseStatus,
      phase: "ready",
      owner: "external",
      ready: true,
      canStart: false,
      modelIds: ["actual-bonsai-id"],
    } satisfies PiInferenceServerStatus;
    NodeAssert.match(piInferenceServerStatusLabel(status), /External inference server ready/);
    NodeAssert.match(piInferenceServerStatusLabel(status), /actual-bonsai-id/);
  });

  it("omits path tokens from the composer status label", () => {
    const status = {
      ...baseStatus,
      endpoint: "http://127.0.0.1:8080/path-secret/v1",
      phase: "ready",
      ready: true,
    } satisfies PiInferenceServerStatus;
    const label = piInferenceServerStatusLabel(status);
    NodeAssert.match(label, /http:\/\/127\.0\.0\.1:8080/);
    NodeAssert.ok(!label.includes("path-secret"));
    NodeAssert.ok(!label.includes("/v1"));
  });

  it("keeps startup failure visible for retry", () => {
    const status = {
      ...baseStatus,
      phase: "failed",
      error: "Readiness timed out after 600s: HTTP /v1/models returned 503.",
    } satisfies PiInferenceServerStatus;
    NodeAssert.equal(piInferenceServerStatusLabel(status), status.error);
  });

  it("clears the provider refresh key while off so a same-endpoint restart refreshes models", () => {
    const ready = {
      ...baseStatus,
      phase: "ready",
      ready: true,
      modelIds: ["actual-model-id"],
    } satisfies PiInferenceServerStatus;
    const firstKey = piInferenceServerReadyRefreshKey(ready, "local", "pi-default");
    NodeAssert.equal(firstKey, 'local:pi-default:http://127.0.0.1:8080/v1:["actual-model-id"]');
    NodeAssert.equal(piInferenceServerReadyRefreshKey(baseStatus, "local", "pi-default"), null);

    const restartedKey = piInferenceServerReadyRefreshKey(ready, "local", "pi-default");
    NodeAssert.equal(restartedKey, firstKey);

    const changedCatalog = {
      ...ready,
      modelIds: ["replacement-model-id"],
    } satisfies PiInferenceServerStatus;
    NodeAssert.notEqual(
      piInferenceServerReadyRefreshKey(changedCatalog, "local", "pi-default"),
      firstKey,
    );
  });
});
