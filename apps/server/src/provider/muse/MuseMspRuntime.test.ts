import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { NotificationHandler } from "@muse-code/sdk";

import {
  MUSE_CLIENT_INFO,
  decodeMuseModelRows,
  installNotificationFanout,
  museScopedMcpSettingsDocument,
  readMuseVersionPin,
  resolveMuseConfigDir,
  resolveMuseServeBinary,
  stripMuseApiKeys,
} from "./MuseMspRuntime.ts";

describe("MUSE_CLIENT_INFO", () => {
  it("uses a handshake-legal machine identifier", () => {
    expect(MUSE_CLIENT_INFO.name).toMatch(/^[a-z0-9_]+$/);
  });
});

describe("stripMuseApiKeys", () => {
  it("removes both API-key entries and reports them", () => {
    const base: NodeJS.ProcessEnv = {
      META_API_KEY: "meta-test",
      MODEL_API_KEY: "model-test",
      PATH: "/bin",
    };

    const { env, stripped } = stripMuseApiKeys(base);

    expect(env).toEqual({ PATH: "/bin" });
    expect([...stripped].sort()).toEqual(["META_API_KEY", "MODEL_API_KEY"]);
    expect(base).toEqual({ META_API_KEY: "meta-test", MODEL_API_KEY: "model-test", PATH: "/bin" });
  });

  it("keeps subscription logins untouched and reports nothing stripped", () => {
    const { env, stripped } = stripMuseApiKeys({ PATH: "/bin", HOME: "/home/user" });

    expect(env).toEqual({ PATH: "/bin", HOME: "/home/user" });
    expect(stripped).toEqual([]);
  });
});

describe("museScopedMcpSettingsDocument", () => {
  it("merges the t3-code entry into the user settings, keeping provider/model", () => {
    const document = museScopedMcpSettingsDocument({
      existingSettingsJson: JSON.stringify({
        schema_version: 1,
        provider: "meta",
        model: "muse-spark-1.3",
        mcpServers: { other: { url: "http://localhost:1/" } },
      }),
      endpoint: "http://127.0.0.1:4242/mcp",
      authorizationHeader: "Bearer thread-token",
    });

    expect(JSON.parse(document)).toEqual({
      schema_version: 1,
      provider: "meta",
      model: "muse-spark-1.3",
      mcpServers: {
        other: { url: "http://localhost:1/" },
        "t3-code": {
          url: "http://127.0.0.1:4242/mcp",
          headers: { Authorization: "Bearer thread-token" },
        },
      },
    });
  });

  it("falls back to a minimal document without usable settings", () => {
    for (const existingSettingsJson of [undefined, "{oops", "[1,2]"]) {
      expect(
        JSON.parse(
          museScopedMcpSettingsDocument({
            existingSettingsJson,
            endpoint: "http://127.0.0.1:4242/mcp",
            authorizationHeader: "Bearer thread-token",
          }),
        ),
      ).toEqual({
        schema_version: 1,
        mcpServers: {
          "t3-code": {
            url: "http://127.0.0.1:4242/mcp",
            headers: { Authorization: "Bearer thread-token" },
          },
        },
      });
    }
  });
});

describe("resolveMuseConfigDir", () => {
  it("prefers XDG_CONFIG_HOME and falls back to home .config", () => {
    expect(
      resolveMuseConfigDir({ env: { XDG_CONFIG_HOME: "C:\\scoped" }, homeDir: "C:\\home" }),
    ).toBe("C:\\scoped/muse");
    expect(resolveMuseConfigDir({ env: {}, homeDir: "C:\\home" })).toBe("C:\\home/.config/muse");
  });
});

describe("installNotificationFanout", () => {
  it("delivers every notification to the facade router and late bridges", () => {
    const seen: Array<{ slot: string; method: string }> = [];
    let slot: NotificationHandler | undefined;
    const target: { onNotification(handler: NotificationHandler): void } = {
      onNotification(handler) {
        slot = handler;
      },
    };
    const add = installNotificationFanout(target);
    // The facade registers through the overridden slot during client setup.
    target.onNotification((notification) => {
      seen.push({ slot: "facade", method: notification.method });
    });
    add((notification) => {
      seen.push({ slot: "bridge", method: notification.method });
    });
    slot?.({ jsonrpc: "2.0", method: "turn/started" });

    expect(seen).toEqual([
      { slot: "facade", method: "turn/started" },
      { slot: "bridge", method: "turn/started" },
    ]);
  });
});

describe("decodeMuseModelRows", () => {
  it("keeps well-formed rows and drops malformed ones", () => {
    expect(
      decodeMuseModelRows({
        models: [
          {
            modelId: "muse-spark",
            displayLabel: "Muse Spark",
            isDefault: true,
            providerId: "meta",
          },
          { modelId: "", displayLabel: "blank" },
          { displayLabel: "no id" },
          "garbage",
        ],
        providerId: "meta",
      }),
    ).toEqual([
      { modelId: "muse-spark", displayLabel: "Muse Spark", isDefault: true, providerId: "meta" },
    ]);
  });

  it("returns empty for non-catalog payloads", () => {
    expect(decodeMuseModelRows(undefined)).toEqual([]);
    expect(decodeMuseModelRows({})).toEqual([]);
    expect(decodeMuseModelRows({ models: "muse-spark" })).toEqual([]);
  });
});

describe("resolveMuseServeBinary", () => {
  it.effect("prefers a configured .exe that exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-muse-bin-" });
      const exe = path.join(dir, "muse.exe");
      yield* fileSystem.writeFileString(exe, "binary");

      const resolved = yield* resolveMuseServeBinary({
        binaryPath: exe,
        platform: "win32",
      });

      expect(resolved).toBe(exe);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the pinned muse-bin exe beside a launcher on win32", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-muse-bin-" });
      yield* fileSystem.writeFileString(path.join(dir, "muse.cmd"), "launcher");
      yield* fileSystem.writeFileString(path.join(dir, ".muse-version"), "1.3.0-R3233.1\n");
      yield* fileSystem.writeFileString(path.join(dir, "muse-bin-1.3.0-R3233.1.exe"), "binary");

      const pin = yield* readMuseVersionPin({ binaryPath: path.join(dir, "muse.cmd") });
      const resolved = yield* resolveMuseServeBinary({
        binaryPath: path.join(dir, "muse.cmd"),
        platform: "win32",
        ...(pin === undefined ? {} : { pinnedVersion: pin }),
      });

      expect(resolved).toBe(path.join(dir, "muse-bin-1.3.0-R3233.1.exe"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with a runnable-binary hint when nothing resolves", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-muse-bin-" });

      const failure = yield* Effect.flip(
        resolveMuseServeBinary({ binaryPath: path.join(dir, "muse.cmd"), platform: "win32" }),
      );

      expect(failure).toBeInstanceOf(ProviderAdapterRequestError);
      expect(failure.method).toBe("msp/resolveBinary");
      expect(failure.detail).toContain("native muse .exe");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves a bare command through a fake PATH on win32", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-muse-path-" });
      yield* fileSystem.writeFileString(path.join(dir, "muse.cmd"), "launcher");
      yield* fileSystem.writeFileString(path.join(dir, "muse-bin-9.9.9.exe"), "binary");

      const resolved = yield* resolveMuseServeBinary({
        binaryPath: "muse",
        platform: "win32",
        pathEnv: `/nothing;${dir}`,
      });

      expect(resolved).toBe(path.join(dir, "muse-bin-9.9.9.exe"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed on posix without launcher probing", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveMuseServeBinary({ binaryPath: "/missing/muse", platform: "linux" }),
      );

      expect(failure).toBeInstanceOf(ProviderAdapterRequestError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
