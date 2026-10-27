/**
 * Maps a fork `providerInstances` map onto V2 driver kinds and configs.
 * V1 kinds that V2 renamed (`museCode`, `kimi`) would otherwise land on
 * unregistered drivers. Pure: callers pass two parsed settings objects.
 */

type JsonObject = Record<string, unknown>;

export interface ProviderSettingsImportInput {
  readonly source: unknown;
  readonly target: unknown;
  /** Replace instances the target already has. Off by default to keep V2-side edits. */
  readonly overwrite?: boolean;
  /** Resolves a bare command name to an absolute path; the CLI uses `where`/`which`. */
  readonly resolveExecutable?: (command: string) => string;
}

export interface ProviderSettingsImportReport {
  readonly imported: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ readonly instanceId: string; readonly reason: string }>;
  readonly unrecognizedDrivers: ReadonlyArray<string>;
}

export interface ProviderSettingsImportResult {
  readonly settings: JsonObject;
  readonly report: ProviderSettingsImportReport;
  readonly changed: boolean;
}

const DRIVER_RENAMES: Readonly<Record<string, string>> = {
  kimi: "acpRegistry",
  museCode: "muse",
};

/** Drivers this V2 build registers; anything else still round-trips as unavailable. */
const KNOWN_V2_DRIVERS: ReadonlySet<string> = new Set([
  "acpRegistry",
  "antigravity",
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "muse",
  "opencode",
  "pi",
]);

const SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const enabledFlag = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const mapConfig = (
  driver: string,
  rawConfig: JsonObject,
  resolveExecutable: (command: string) => string,
): JsonObject => {
  const config = cloneJson(rawConfig);
  delete config.enabled;

  if (driver === "kimi") {
    const binaryPath = stringField(config.binaryPath) ?? "kimi";
    // V1's Kimi driver always launched the CLI in ACP mode.
    return {
      source: "local",
      agentId: "kimi",
      commandPath: resolveExecutable(binaryPath),
      commandArgs: ["acp"],
      customModels: stringArray(config.customModels),
    };
  }

  if (driver === "museCode") {
    delete config.homePath;
    return config;
  }

  return config;
};

const mapInstance = (
  instanceId: string,
  raw: unknown,
  resolveExecutable: (command: string) => string,
): { readonly entry?: JsonObject; readonly driver?: string; readonly reason?: string } => {
  if (!isRecord(raw)) {
    return { reason: "instance is not an object" };
  }
  const driver = stringField(raw.driver);
  if (driver === undefined || !SLUG.test(driver)) {
    return { reason: "missing or invalid driver kind" };
  }
  if (raw.config !== undefined && !isRecord(raw.config)) {
    return { reason: "config is not an object" };
  }

  const rawConfig = isRecord(raw.config) ? raw.config : {};
  const mappedDriver = DRIVER_RENAMES[driver] ?? driver;
  const config = mapConfig(driver, rawConfig, resolveExecutable);

  // V1 folded these two flags most-restrictively; mirror that so a disable is kept.
  const configEnabled = enabledFlag(rawConfig.enabled);
  const envelopeEnabled = enabledFlag(raw.enabled);
  const enabled =
    envelopeEnabled === false || configEnabled === false
      ? false
      : (envelopeEnabled ?? configEnabled);

  const entry: JsonObject = { driver: mappedDriver };
  const displayName = stringField(raw.displayName);
  if (displayName !== undefined) entry.displayName = displayName;
  const accentColor = stringField(raw.accentColor);
  if (accentColor !== undefined) entry.accentColor = accentColor;
  if (Array.isArray(raw.environment)) entry.environment = cloneJson(raw.environment);
  if (enabled !== undefined) entry.enabled = enabled;
  entry.config = config;

  return { entry, driver: mappedDriver };
};

export const importProviderSettings = (
  input: ProviderSettingsImportInput,
): ProviderSettingsImportResult => {
  if (!isRecord(input.source)) throw new TypeError("Source settings must be a JSON object.");
  if (!isRecord(input.target)) throw new TypeError("Target settings must be a JSON object.");

  const resolveExecutable = input.resolveExecutable ?? ((command: string) => command);
  const overwrite = input.overwrite ?? false;
  const sourceInstances = isRecord(input.source.providerInstances)
    ? input.source.providerInstances
    : {};
  const targetInstances = isRecord(input.target.providerInstances)
    ? input.target.providerInstances
    : {};

  const nextInstances: JsonObject = { ...targetInstances };
  const imported: string[] = [];
  const updated: string[] = [];
  const retained: string[] = [];
  const skipped: Array<{ instanceId: string; reason: string }> = [];
  const unrecognizedDrivers = new Set<string>();

  for (const [instanceId, raw] of Object.entries(sourceInstances)) {
    if (!SLUG.test(instanceId)) {
      skipped.push({ instanceId, reason: "instance id is not a valid provider slug" });
      continue;
    }
    const mapped = mapInstance(instanceId, raw, resolveExecutable);
    if (mapped.entry === undefined) {
      skipped.push({ instanceId, reason: mapped.reason ?? "unsupported instance" });
      continue;
    }
    if (mapped.driver !== undefined && !KNOWN_V2_DRIVERS.has(mapped.driver)) {
      unrecognizedDrivers.add(mapped.driver);
    }

    const existing = nextInstances[instanceId];
    if (existing !== undefined) {
      // A target entry still carrying the V1 driver kind is a half-migrated
      // copy (or the same file imported in place); finish it. Once the driver
      // matches, the entry is V2's and is kept unless --overwrite asks.
      const existingDriver = isRecord(existing) ? stringField(existing.driver) : undefined;
      if (!overwrite && existingDriver === mapped.entry.driver) {
        retained.push(instanceId);
        continue;
      }
      if (deepEqual(existing, mapped.entry)) continue;
      nextInstances[instanceId] = mapped.entry;
      updated.push(instanceId);
      continue;
    }

    nextInstances[instanceId] = mapped.entry;
    imported.push(instanceId);
  }

  const report: ProviderSettingsImportReport = {
    imported,
    updated,
    retained,
    skipped,
    unrecognizedDrivers: [...unrecognizedDrivers].sort(),
  };

  if (deepEqual(targetInstances, nextInstances)) {
    return { settings: input.target, report, changed: false };
  }
  return {
    settings: { ...input.target, providerInstances: nextInstances },
    report,
    changed: true,
  };
};
