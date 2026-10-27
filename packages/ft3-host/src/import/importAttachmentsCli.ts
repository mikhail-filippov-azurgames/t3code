// @effect-diagnostics nodeBuiltinImport:off - one-shot migration CLI copies served chat attachments between two T3 homes.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { importAttachments, type AttachmentImportReport } from "./importAttachments.ts";

const usage = `Usage: node packages/ft3-host/src/import/importAttachmentsCli.ts <source-home> <target-home> [--overwrite] [--dry-run]

Copies <source-home>/userdata/attachments into <target-home>/userdata/attachments.
V2 resolves attachments by <attachment id>.<extension> inside its own home, so
the file names carry the lookup and no database rows are written. Identical
files are skipped; differing files are kept unless --overwrite is passed.
`;

const formatReport = (report: AttachmentImportReport, changed: boolean): string => {
  const lines = [
    `source: ${report.sourceDir}`,
    `target: ${report.targetDir}`,
    `files: ${report.sourceFiles}`,
    `copied: ${report.copied}`,
    `replaced: ${report.replaced}`,
    `identical: ${report.identical}`,
    changed ? "attachments: changed" : "attachments: unchanged",
  ];
  if (report.conflicts.length > 0) {
    lines.push(`kept (bytes differ): ${report.conflicts.join(", ")}`);
  }
  if (report.invalid.length > 0) {
    lines.push(`skipped (not a V2 attachment name): ${report.invalid.join(", ")}`);
  }
  return lines.join("\n");
};

const main = async (): Promise<void> => {
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

  const [sourceHome, targetHome] = positional as [string, string];
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

  const result = await importAttachments({
    sourceHome,
    targetHome,
    overwrite: flags.has("--overwrite"),
    dryRun: flags.has("--dry-run"),
  });
  NodeProcess.stdout.write(`${formatReport(result.report, result.changed)}\n`);
  if (result.changed && flags.has("--dry-run")) {
    NodeProcess.stdout.write(`dry run; no files written under ${NodePath.resolve(targetHome)}\n`);
  }
};

await main();
