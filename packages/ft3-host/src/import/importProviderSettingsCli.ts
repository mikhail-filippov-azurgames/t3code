// @effect-diagnostics nodeBuiltinImport:off - one-shot migration CLI that rewrites two settings files and resolves a PATH command.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import {
  importProviderSettings,
  type ProviderSettingsImportReport,
} from "./importProviderSettings.ts";

const usage = `Usage: node packages/ft3-host/src/import/importProviderSettingsCli.ts <source-settings.json> <target-settings.json> [--overwrite] [--dry-run]

Copies provider instances from a pre-V2 home into a V2 home, translating the
driver kinds and configs V2 renamed (museCode -> muse, kimi -> acpRegistry).
Existing target instances are kept unless --overwrite is passed.
`;

const RESOLVE_CACHE = new Map<string, string>();

const isBareCommand = (command: string): boolean =>
  !/[\\/]/.test(command) && !/\.[a-zA-Z0-9]+$/.test(command);

const resolveExecutable = (command: string): string => {
  if (!isBareCommand(command)) return command;
  const cached = RESOLVE_CACHE.get(command);
  if (cached !== undefined) return cached;
  let resolved = command;
  try {
    const tool = NodeProcess.platform === "win32" ? "where.exe" : "which";
    const output = NodeChildProcess.execFileSync(tool, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first !== undefined) resolved = first;
  } catch {
    // Keep the bare command; the provider reports "not installed" instead of failing the import.
  }
  RESOLVE_CACHE.set(command, resolved);
  return resolved;
};

const readJson = (path: string): unknown =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;

const formatReport = (report: ProviderSettingsImportReport, changed: boolean): string => {
  const lines: string[] = [];
  lines.push(`imported: ${report.imported.join(", ") || "-"}`);
  lines.push(`updated: ${report.updated.join(", ") || "-"}`);
  lines.push(`retained: ${report.retained.join(", ") || "-"}`);
  if (report.skipped.length > 0) {
    lines.push(
      `skipped: ${report.skipped.map((item) => `${item.instanceId} (${item.reason})`).join(", ")}`,
    );
  }
  if (report.unrecognizedDrivers.length > 0) {
    lines.push(`unrecognized drivers: ${report.unrecognizedDrivers.join(", ")}`);
  }
  lines.push(changed ? "settings: changed" : "settings: unchanged");
  return lines.join("\n");
};

const main = (): void => {
  const args = NodeProcess.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const positional = args.filter((arg) => !arg.startsWith("--"));

  if (positional.length !== 2 || flags.has("--help") || flags.has("-h")) {
    NodeProcess.stdout.write(usage);
    if (positional.length !== 2 && !flags.has("--help") && !flags.has("-h")) process.exitCode = 2;
    return;
  }

  const unknownFlag = [...flags].find(
    (flag) => !["--overwrite", "--dry-run", "--help", "-h"].includes(flag),
  );
  if (unknownFlag !== undefined) {
    NodeProcess.stderr.write(`Unknown flag: ${unknownFlag}\n${usage}`);
    process.exitCode = 2;
    return;
  }

  const [sourcePath, targetPath] = positional as [string, string];
  if (!NodeFS.existsSync(sourcePath)) {
    NodeProcess.stderr.write(`Source settings not found: ${sourcePath}\n`);
    process.exitCode = 1;
    return;
  }
  if (!NodeFS.existsSync(targetPath)) {
    NodeProcess.stderr.write(`Target settings not found: ${targetPath}\n`);
    process.exitCode = 1;
    return;
  }

  const result = importProviderSettings({
    source: readJson(sourcePath),
    target: readJson(targetPath),
    overwrite: flags.has("--overwrite"),
    resolveExecutable,
  });
  NodeProcess.stdout.write(`${formatReport(result.report, result.changed)}\n`);

  if (!result.changed || flags.has("--dry-run")) return;

  const backupPath = `${targetPath}.before-provider-import.bak`;
  NodeFS.writeFileSync(backupPath, NodeFS.readFileSync(targetPath));
  const temporaryPath = `${targetPath}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(result.settings, null, 2)}\n`);
  NodeFS.renameSync(temporaryPath, targetPath);
  NodeProcess.stdout.write(
    `wrote ${NodePath.basename(targetPath)} (backup: ${NodePath.basename(backupPath)})\n`,
  );
};

main();
