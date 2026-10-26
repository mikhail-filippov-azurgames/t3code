// @effect-diagnostics nodeBuiltinImport:off - Tests need a disposable agent dir fixture.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildPiModelsJson,
  ensurePiAgentFiles,
  resolvePiManagedModels,
  withPiAgentDir,
} from "./agentDir.ts";

const withTempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-agent-"))),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);

const files = async (dir: string) => ({
  models: await NodeFSP.readFile(NodePath.join(dir, "models.json"), "utf8"),
  settings: await NodeFSP.readFile(NodePath.join(dir, "settings.json"), "utf8"),
});

it.effect("writes the managed catalog and never trusts project resources", () =>
  Effect.gen(function* () {
    const dir = yield* withTempDir;
    yield* ensurePiAgentFiles(dir, {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "local",
      models: ["bonsai-2-27b", "ft3-local/bonsai-2-27b", "qwen"],
      runtimeMode: "full-access",
      defaultModel: "ft3-local/bonsai-2-27b",
    });

    const written = yield* Effect.promise(() => files(dir));
    assert.deepEqual(JSON.parse(written.models), {
      providers: {
        "ft3-local": {
          baseUrl: "http://127.0.0.1:8080/v1",
          api: "openai-completions",
          apiKey: "local",
          models: [{ id: "bonsai-2-27b" }, { id: "qwen" }],
        },
      },
    });
    const settings = JSON.parse(written.settings) as {
      defaultModel: string;
      defaultProjectTrust: string;
      defaultTools: ReadonlyArray<string>;
    };
    assert.equal(settings.defaultProjectTrust, "never");
    assert.equal(settings.defaultModel, "ft3-local/bonsai-2-27b");
    assert.includeMembers([...settings.defaultTools], ["read", "bash", "edit", "write"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rewrites only when the turn changes the pinned tools", () =>
  Effect.gen(function* () {
    const dir = yield* withTempDir;
    const input = {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "local",
      models: ["bonsai-2-27b"],
      runtimeMode: "approval-required" as const,
      defaultModel: "bonsai-2-27b",
    };
    yield* ensurePiAgentFiles(dir, input);
    const first = yield* Effect.promise(() =>
      NodeFSP.stat(NodePath.join(dir, "settings.json")).then((stat) => stat.mtimeMs),
    );
    yield* ensurePiAgentFiles(dir, input);
    const second = yield* Effect.promise(() =>
      NodeFSP.stat(NodePath.join(dir, "settings.json")).then((stat) => stat.mtimeMs),
    );
    assert.equal(second, first);

    yield* ensurePiAgentFiles(dir, { ...input, runtimeMode: "auto" });
    const auto = JSON.parse(
      yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, "settings.json"), "utf8")),
    ) as { defaultTools: ReadonlyArray<string> };
    assert.includeMembers([...auto.defaultTools], ["edit", "write"]);
    assert.isFalse(auto.defaultTools.includes("bash"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("dedupes managed models and keeps the provider prefix out of the catalog", () => {
  assert.deepEqual(
    resolvePiManagedModels({
      configuredModel: "ft3-local/bonsai-2-27b",
      profileModels: ["bonsai-2-27b", "qwen"],
      customModels: ["qwen", { slug: "llama" }],
    }),
    ["bonsai-2-27b", "qwen", "llama"],
  );
  assert.include(buildPiModelsJson({ baseUrl: "", apiKey: "", models: [] }), "127.0.0.1:11434");
});

it("replaces an inherited agent dir variable", () => {
  assert.deepEqual(
    withPiAgentDir(
      [
        { name: "PATH", value: "/bin" },
        { name: "PI_CODING_AGENT_DIR", value: "/ambient" },
      ],
      "/managed",
    ),
    [
      { name: "PATH", value: "/bin", sensitive: false },
      { name: "PI_CODING_AGENT_DIR", value: "/managed", sensitive: false },
    ],
  );
});
