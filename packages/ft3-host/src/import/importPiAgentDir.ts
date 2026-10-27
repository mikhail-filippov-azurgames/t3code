// @effect-diagnostics nodeBuiltinImport:off - one-shot migration copies agent-dir files between two T3 homes.

import {
  derivePiInferenceConfigFromLegacySettings,
  type PiInferenceConfig,
} from "@t3tools/ft3-pi/server";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

type JsonObject = Record<string, unknown>;

export interface PiAgentImportInput {
  /** Pre-V2 home root; its `userdata` directory holds Pi state. */
  readonly sourceHome: string;
  /** V2 home root; the migration writes only below its `userdata` directory. */
  readonly targetHome: string;
  readonly instanceId?: string;
  /** Replace existing target files instead of keeping V2-side state. */
  readonly overwrite?: boolean;
  /** Report the planned actions without touching the target home. */
  readonly dryRun?: boolean;
}

export type PiAgentFileAction =
  | "imported"
  | "seeded"
  | "copied"
  | "retained"
  | "missing"
  | "skipped";

export interface PiAgentImportReport {
  readonly instanceId: string;
  readonly profiles: PiAgentFileAction;
  readonly models: PiAgentFileAction;
  readonly auth: PiAgentFileAction;
  readonly modelsStore: PiAgentFileAction;
  readonly profilesPath: string;
  readonly written: ReadonlyArray<string>;
}

export interface PiAgentImportResult {
  readonly report: PiAgentImportReport;
  readonly changed: boolean;
}

const SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
};

const jsonEqual = (left: string, right: string): boolean => {
  try {
    return deepEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return left === right;
  }
};

const readText = async (filePath: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return undefined;
    throw cause;
  }
};

const readJson = async (filePath: string): Promise<unknown> => {
  const text = await readText(filePath);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(
      `Cannot parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
  }
};

const parseJsonObject = (text: string): JsonObject | undefined => {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const profilesFromText = (text: string | undefined): ReadonlyArray<unknown> | undefined => {
  if (text === undefined) return undefined;
  const document = parseJsonObject(text);
  const profiles = document?.profiles;
  return Array.isArray(profiles) ? profiles : undefined;
};

/** Count model entries across every provider so a partial seed still counts as empty. */
const modelCount = (text: string | undefined): number => {
  const document = text === undefined ? undefined : parseJsonObject(text);
  const providers = document === undefined ? undefined : document.providers;
  if (!isRecord(providers)) return 0;
  let count = 0;
  for (const provider of Object.values(providers)) {
    if (isRecord(provider) && Array.isArray(provider.models)) count += provider.models.length;
  }
  return count;
};

const isEmptyJsonObject = (text: string): boolean => {
  const document = parseJsonObject(text);
  return document !== undefined && Object.keys(document).length === 0;
};

const writeFileWithBackup = async (filePath: string, content: string): Promise<void> => {
  const existing = await readText(filePath);
  if (existing !== undefined && existing.length > 0) {
    await NodeFSP.writeFile(`${filePath}.before-pi-agent-import.bak`, existing, "utf8");
  }
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, content, "utf8");
};

const sourcePiConfig = (settings: unknown, instanceId: string): JsonObject | undefined => {
  const instances = isRecord(settings) ? settings.providerInstances : undefined;
  const instance = isRecord(instances) ? instances[instanceId] : undefined;
  const config = isRecord(instance) ? instance.config : undefined;
  return isRecord(config) ? config : undefined;
};

const sourceModelsBaseUrl = (models: unknown): string | undefined => {
  const providers = isRecord(models) ? models.providers : undefined;
  const provider = isRecord(providers) ? providers["ft3-local"] : undefined;
  return isRecord(provider) ? stringField(provider.baseUrl) : undefined;
};

const serializeProfiles = (config: PiInferenceConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

const copyAction = async (input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly overwrite: boolean;
  readonly dryRun: boolean;
}): Promise<{ readonly action: PiAgentFileAction; readonly written: boolean }> => {
  const source = await readText(input.sourcePath);
  if (source === undefined) return { action: "missing", written: false };
  const target = await readText(input.targetPath);

  const shouldWrite =
    target === undefined ||
    input.overwrite ||
    (isEmptyJsonObject(target) && !isEmptyJsonObject(source));
  if (!shouldWrite) return { action: "retained", written: false };
  if (target !== undefined && jsonEqual(target, source)) {
    return { action: "retained", written: false };
  }
  if (!input.dryRun) await writeFileWithBackup(input.targetPath, source);
  return { action: "copied", written: true };
};

/**
 * Bring the V1 Pi agent dir into a V2 home: fetch credentials/state, seed the
 * model catalog, and rebuild the V2-only `inference-profiles.json` from the
 * legacy instance settings. Existing V2 files win unless `overwrite` is set.
 */
export const importPiAgentDir = async (input: PiAgentImportInput): Promise<PiAgentImportResult> => {
  const instanceId = input.instanceId ?? "pi";
  if (!SLUG.test(instanceId)) {
    throw new Error(`Invalid Pi instance id: ${instanceId}`);
  }

  const sourceHome = NodePath.resolve(input.sourceHome);
  const targetHome = NodePath.resolve(input.targetHome);
  const sourceStateDir = NodePath.join(sourceHome, "userdata");
  const sourcePiDir = NodePath.join(sourceStateDir, "pi", instanceId);
  const sourceAgentDir = NodePath.join(sourcePiDir, "agent");
  const targetPiDir = NodePath.join(targetHome, "userdata", "pi", instanceId);
  const targetAgentDir = NodePath.join(targetPiDir, "agent");
  const profilesPath = NodePath.join(targetPiDir, "inference-profiles.json");
  const sourceProfilesPath = NodePath.join(sourcePiDir, "inference-profiles.json");

  const sourceModelsText = await readText(NodePath.join(sourceAgentDir, "models.json"));
  const sourceModels =
    sourceModelsText === undefined ? undefined : parseJsonObject(sourceModelsText);
  const sourceProfilesText = await readText(sourceProfilesPath);
  const sourceProfiles = profilesFromText(sourceProfilesText);
  const sourceSettings = await readJson(NodePath.join(sourceStateDir, "settings.json"));
  const legacyConfig = sourcePiConfig(sourceSettings, instanceId);

  let desiredProfilesText: string | undefined;
  if (sourceProfiles !== undefined && sourceProfiles.length > 0) {
    desiredProfilesText = sourceProfilesText;
  } else if (legacyConfig !== undefined) {
    const derived = derivePiInferenceConfigFromLegacySettings(legacyConfig, {
      fallbackBaseUrl: sourceModelsBaseUrl(sourceModels),
    });
    if (derived !== undefined) desiredProfilesText = serializeProfiles(derived);
  }

  const existingProfilesText = await readText(profilesPath);
  const existingProfiles = profilesFromText(existingProfilesText);
  const targetHasProfiles = (existingProfiles?.length ?? 0) > 0;

  let profilesAction: PiAgentFileAction = "missing";
  if (desiredProfilesText !== undefined && (!targetHasProfiles || input.overwrite)) {
    if (
      existingProfilesText !== undefined &&
      jsonEqual(existingProfilesText, desiredProfilesText)
    ) {
      profilesAction = "retained";
    } else {
      if (!input.dryRun) await writeFileWithBackup(profilesPath, desiredProfilesText);
      profilesAction = "imported";
    }
  } else if (targetHasProfiles) {
    profilesAction = "retained";
  }

  const targetModelsPath = NodePath.join(targetAgentDir, "models.json");
  const existingModelsText = await readText(targetModelsPath);
  const targetModels = modelCount(existingModelsText);
  const sourceModelsCount = modelCount(sourceModelsText);
  let modelsAction: PiAgentFileAction = "missing";
  if (targetModels > 0 && !(input.overwrite ?? false)) {
    modelsAction = "retained";
  } else if (sourceModelsCount > 0) {
    if (existingModelsText !== undefined && jsonEqual(existingModelsText, sourceModelsText ?? "")) {
      modelsAction = "retained";
    } else {
      if (!input.dryRun) await writeFileWithBackup(targetModelsPath, sourceModelsText ?? "");
      modelsAction = "seeded";
    }
  } else if (targetModels > 0) {
    modelsAction = "retained";
  }

  const auth = await copyAction({
    sourcePath: NodePath.join(sourceAgentDir, "auth.json"),
    targetPath: NodePath.join(targetAgentDir, "auth.json"),
    overwrite: input.overwrite ?? false,
    dryRun: input.dryRun ?? false,
  });
  const modelsStore = await copyAction({
    sourcePath: NodePath.join(sourceAgentDir, "models-store.json"),
    targetPath: NodePath.join(targetAgentDir, "models-store.json"),
    overwrite: input.overwrite ?? false,
    dryRun: input.dryRun ?? false,
  });

  const written = [
    ...(profilesAction === "imported" ? [profilesPath] : []),
    ...(modelsAction === "seeded" ? [targetModelsPath] : []),
    ...(auth.written ? [NodePath.join(targetAgentDir, "auth.json")] : []),
    ...(modelsStore.written ? [NodePath.join(targetAgentDir, "models-store.json")] : []),
  ];

  return {
    changed: written.length > 0,
    report: {
      instanceId,
      profiles: profilesAction,
      models: modelsAction,
      auth: auth.action,
      modelsStore: modelsStore.action,
      profilesPath,
      written,
    },
  };
};
