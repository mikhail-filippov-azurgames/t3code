// @effect-diagnostics nodeBuiltinImport:off - one-shot migration CLI copies a pre-V2 Pi agent dir into a V2 home.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { importPiAgentDir, type PiAgentImportReport } from "./importPiAgentDir.ts";

const usage = `Usage: node packages/ft3-host/src/import/importPiAgentDirCli.ts <source-home> <target-home> [--instance pi] [--overwrite] [--dry-run]

Copies Pi credentials, model catalog, and inference profiles from a pre-V2 home
into a V2 home. The V2-only inference-profiles.json is derived from the source
instance settings when the source has no such file. Existing V2 files win
unless --overwrite is passed.
`;

const formatReport = (report: PiAgentImportReport, changed: boolean): string => {
  const lines = [
    `instance: ${report.instanceId}`,
    `profiles: ${report.profiles}`,
    `models: ${report.models}`,
    `auth: ${report.auth}`,
    `models store: ${report.modelsStore}`,
    `profiles path: ${report.profilesPath}`,
    changed ? "agent dir: changed" : "agent dir: unchanged",
  ];
  if (report.written.length > 0) lines.push(`written: ${report.written.join(", ")}`);
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const args = NodeProcess.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const instanceIndex = args.findIndex((arg) => arg === "--instance");
  const instanceFromSpace = instanceIndex >= 0 ? args[instanceIndex + 1] : undefined;
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && !(instanceIndex >= 0 && index === instanceIndex + 1),
  );

  if (positional.length !== 2 || flags.has("--help") || flags.has("-h")) {
    NodeProcess.stdout.write(usage);
    if (positional.length !== 2 && !flags.has("--help") && !flags.has("-h")) process.exitCode = 2;
    return;
  }

  const [sourceHome, targetHome] = positional as [string, string];
  const instanceFlag = args.find((arg) => arg.startsWith("--instance="));
  const instanceId = instanceFlag?.slice("--instance=".length) ?? instanceFromSpace ?? "pi";

  const allowed = new Set(["--instance", "--overwrite", "--dry-run", "--help", "-h"]);
  const unknownFlag = [...flags].find(
    (flag) => !allowed.has(flag) && !flag.startsWith("--instance="),
  );
  if (unknownFlag !== undefined) {
    NodeProcess.stderr.write(`Unknown flag: ${unknownFlag}\n${usage}`);
    process.exitCode = 2;
    return;
  }

  for (const [label, directory] of [
    ["Source home", sourceHome],
    ["Target home", targetHome],
  ] as const) {
    if (!NodeFS.existsSync(directory) || !NodeFS.statSync(directory).isDirectory()) {
      NodeProcess.stderr.write(`${label} not found: ${directory}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const result = await importPiAgentDir({
    sourceHome,
    targetHome,
    instanceId,
    overwrite: flags.has("--overwrite"),
    dryRun: flags.has("--dry-run"),
  });
  NodeProcess.stdout.write(`${formatReport(result.report, result.changed)}\n`);
  if (result.report.written.length > 0 && flags.has("--dry-run")) {
    NodeProcess.stdout.write(`dry run; no files written under ${NodePath.resolve(targetHome)}\n`);
  }
};

await main();
