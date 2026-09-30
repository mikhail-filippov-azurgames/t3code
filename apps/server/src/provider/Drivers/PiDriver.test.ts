// @effect-diagnostics nodeBuiltinImport:off - Pure host-path selection test.
import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";

import { resolvePiCodexResourceHome } from "./PiDriver.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("Pi Codex resource source", () => {
  it("uses the selected personal Codex instance and honors an explicit per-Pi choice", () => {
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const personalHome = NodePath.resolve("personal-codex-home");
    const workHome = NodePath.resolve("work-codex-home");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [personalId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Personal Codex",
          config: { homePath: personalHome },
        },
        [workId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Work Codex",
          config: { homePath: workHome },
        },
      },
      defaultModelSelection: { instanceId: workId, model: "fixture" },
    };
    NodeAssert.equal(resolvePiCodexResourceHome(settings, decodePiSettings({})), personalHome);
    NodeAssert.equal(
      resolvePiCodexResourceHome(settings, decodePiSettings({ codexResourceInstanceId: workId })),
      workHome,
    );
    NodeAssert.throws(
      () =>
        resolvePiCodexResourceHome(
          settings,
          decodePiSettings({ codexResourceInstanceId: ProviderInstanceId.make("missing") }),
        ),
      /missing or disabled/,
    );
  });

  it("follows CODEX_HOME when no Codex instance pins a home", () => {
    const ambientHome = NodePath.resolve("ambient-codex-home");
    NodeAssert.equal(
      resolvePiCodexResourceHome(DEFAULT_SERVER_SETTINGS, decodePiSettings({}), {
        CODEX_HOME: ambientHome,
      }),
      ambientHome,
    );
    NodeAssert.equal(
      resolvePiCodexResourceHome(DEFAULT_SERVER_SETTINGS, decodePiSettings({}), {}),
      NodePath.join(NodeOS.homedir(), ".codex"),
    );
  });

  it("prefers an explicit Codex instance home over CODEX_HOME", () => {
    const personalId = ProviderInstanceId.make("codex_personal");
    const personalHome = NodePath.resolve("personal-codex-home");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [personalId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Personal Codex",
          config: { homePath: personalHome },
        },
      },
    };
    NodeAssert.equal(
      resolvePiCodexResourceHome(settings, decodePiSettings({}), {
        CODEX_HOME: NodePath.resolve("ambient-codex-home"),
      }),
      personalHome,
    );
  });
});
