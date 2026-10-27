// @effect-diagnostics nodeBuiltinImport:off - the migration test needs disposable homes.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { importPiAgentDir } from "./importPiAgentDir.ts";

const tempHome = (prefix: string): Promise<string> =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as unknown;

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await NodeFSP.stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const legacyConfig = () => ({
  binaryPath: "pi",
  baseUrl: "http://127.0.0.1:8081/v1",
  apiKey: "",
  model: "ternary-bonsai-8b",
  inferenceServerExecutablePath: "D:\\Bonsai\\bin\\cuda\\llama-server.exe",
  inferenceServerModelPath: "D:\\Bonsai\\models\\ternary-gguf\\8B\\Ternary-Bonsai-8B-PQ2_0.gguf",
  inferenceServerGpuLayers: 99,
  inferenceServerProfiles: [
    {
      model: "ft3-local/bonsai-2-27b",
      baseUrl: "http://127.0.0.1:8080/v1",
      executablePath: "D:\\Bonsai\\bin\\cuda\\llama-server.exe",
      modelPath: "D:\\Bonsai\\models\\bonsai2-gguf\\27B\\Ternary-Bonsai-2-27B-PQ2_0.gguf",
    },
  ],
  customModels: [],
});

const legacyModels = () => ({
  providers: {
    "ft3-local": {
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [{ id: "ternary-bonsai-8b" }, { id: "bonsai-2-27b" }],
    },
  },
});

const seedSource = async (sourceHome: string): Promise<void> => {
  await writeJson(NodePath.join(sourceHome, "userdata", "settings.json"), {
    providerInstances: { pi: { driver: "pi", enabled: true, config: legacyConfig() } },
  });
  const agentDir = NodePath.join(sourceHome, "userdata", "pi", "pi", "agent");
  await writeJson(NodePath.join(agentDir, "models.json"), legacyModels());
  await writeJson(NodePath.join(agentDir, "auth.json"), {});
  await writeJson(NodePath.join(agentDir, "models-store.json"), {});
};

const seedTarget = async (home: string): Promise<void> => {
  await writeJson(NodePath.join(home, "userdata", "pi", "pi", "agent", "models.json"), {
    providers: {
      "ft3-local": {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        models: [],
      },
    },
  });
};

describe("importPiAgentDir", () => {
  it("derives inference profiles and carries credentials into the V2 home", async () => {
    const sourceHome = await tempHome("ft3-pi-src-");
    const targetHome = await tempHome("ft3-pi-dst-");
    try {
      await seedSource(sourceHome);
      await writeJson(NodePath.join(sourceHome, "userdata", "pi", "pi", "agent", "auth.json"), {
        openrouter: { key: "secret" },
      });
      await seedTarget(targetHome);

      const result = await importPiAgentDir({ sourceHome, targetHome });

      assert.isTrue(result.changed);
      assert.equal(result.report.profiles, "imported");
      assert.equal(result.report.models, "seeded");
      assert.equal(result.report.auth, "copied");

      const profiles = (await readJson(result.report.profilesPath)) as {
        baseUrl: string;
        profiles: ReadonlyArray<{ model: string; baseUrl: string }>;
      };
      assert.equal(profiles.baseUrl, "http://127.0.0.1:8080/v1");
      assert.deepEqual(
        profiles.profiles.map((profile) => profile.model),
        ["ft3-local/ternary-bonsai-8b", "ft3-local/bonsai-2-27b"],
      );
      assert.equal(profiles.profiles[0]?.baseUrl, "http://127.0.0.1:8081/v1");
      assert.deepEqual(
        await readJson(NodePath.join(targetHome, "userdata", "pi", "pi", "agent", "models.json")),
        legacyModels(),
      );
      assert.deepEqual(
        await readJson(NodePath.join(targetHome, "userdata", "pi", "pi", "agent", "auth.json")),
        { openrouter: { key: "secret" } },
      );
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("is idempotent across repeated runs", async () => {
    const sourceHome = await tempHome("ft3-pi-src-");
    const targetHome = await tempHome("ft3-pi-dst-");
    try {
      await seedSource(sourceHome);
      await seedTarget(targetHome);
      const first = await importPiAgentDir({ sourceHome, targetHome });
      const second = await importPiAgentDir({ sourceHome, targetHome });

      assert.isTrue(first.changed);
      assert.isFalse(second.changed);
      assert.deepEqual(second.report.written, []);
      assert.equal(second.report.profiles, "retained");
      assert.equal(second.report.models, "retained");
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("keeps V2 files unless overwrite is requested", async () => {
    const sourceHome = await tempHome("ft3-pi-src-");
    const targetHome = await tempHome("ft3-pi-dst-");
    try {
      await seedSource(sourceHome);
      const targetPiDir = NodePath.join(targetHome, "userdata", "pi", "pi");
      await writeJson(NodePath.join(targetPiDir, "inference-profiles.json"), {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "local",
        profiles: [
          {
            model: "ft3-local/v2-only",
            baseUrl: "http://127.0.0.1:8080/v1",
            executablePath: "D:\\v2\\llama-server.exe",
            modelPath: "D:\\v2\\model.gguf",
          },
        ],
      });
      await writeJson(NodePath.join(targetPiDir, "agent", "models.json"), legacyModels());
      await writeJson(NodePath.join(targetPiDir, "agent", "auth.json"), {});
      await writeJson(NodePath.join(targetPiDir, "agent", "models-store.json"), {});

      const kept = await importPiAgentDir({ sourceHome, targetHome });
      assert.isFalse(kept.changed);
      assert.equal(kept.report.profiles, "retained");
      assert.equal(kept.report.models, "retained");
      assert.equal(kept.report.auth, "retained");

      const replaced = await importPiAgentDir({ sourceHome, targetHome, overwrite: true });
      assert.isTrue(replaced.changed);
      assert.equal(replaced.report.profiles, "imported");
      const profiles = (await readJson(NodePath.join(targetPiDir, "inference-profiles.json"))) as {
        profiles: ReadonlyArray<{ model: string }>;
      };
      assert.deepEqual(
        profiles.profiles.map((profile) => profile.model),
        ["ft3-local/ternary-bonsai-8b", "ft3-local/bonsai-2-27b"],
      );
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("copies a source V2 profile file as-is and reads nothing when the source instance is absent", async () => {
    const sourceHome = await tempHome("ft3-pi-src-");
    const targetHome = await tempHome("ft3-pi-dst-");
    try {
      const sourcePiDir = NodePath.join(sourceHome, "userdata", "pi", "pi");
      await writeJson(NodePath.join(sourcePiDir, "inference-profiles.json"), {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "local",
        profiles: [
          {
            model: "ft3-local/bonsai-2-27b",
            baseUrl: "http://127.0.0.1:8080/v1",
            executablePath: "D:\\Bonsai\\bin\\cuda\\llama-server.exe",
            modelPath: "D:\\Bonsai\\models\\bonsai2-gguf\\27B\\model.gguf",
          },
        ],
      });
      const first = await importPiAgentDir({ sourceHome, targetHome });
      assert.equal(first.report.profiles, "imported");

      const absentHome = await tempHome("ft3-pi-absent-");
      try {
        const absent = await importPiAgentDir({ sourceHome: absentHome, targetHome });
        assert.isFalse(absent.changed);
        assert.equal(absent.report.profiles, "retained");
        assert.equal(absent.report.models, "missing");
      } finally {
        await NodeFSP.rm(absentHome, { recursive: true, force: true });
      }
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("writes nothing in a dry run", async () => {
    const sourceHome = await tempHome("ft3-pi-src-");
    const targetHome = await tempHome("ft3-pi-dst-");
    try {
      await seedSource(sourceHome);
      const result = await importPiAgentDir({ sourceHome, targetHome, dryRun: true });
      assert.isTrue(result.changed);
      assert.equal(result.report.profiles, "imported");
      assert.isFalse(
        await exists(NodePath.join(targetHome, "userdata", "pi", "pi", "inference-profiles.json")),
      );
      assert.isFalse(
        await exists(NodePath.join(targetHome, "userdata", "pi", "pi", "agent", "models.json")),
      );
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });
});
