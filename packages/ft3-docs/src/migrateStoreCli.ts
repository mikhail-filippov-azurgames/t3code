#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - the migrator CLI reads and writes report files and opens node:sqlite through the shared client.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  inspectStore,
  isMigrateStoreReport,
  migrateStore,
  type MigrateStoreReport,
  type MigrateStoreResult,
} from "./migrateStore.ts";
import { layer as reconcilerLayer } from "./reconciler.ts";
import { layer as storeLayer } from "./store.ts";

const usage = `Usage:
  node packages/ft3-docs/src/migrateStoreCli.ts --store <store-root> [--report <report.json>]
  node packages/ft3-docs/src/migrateStoreCli.ts --store <store-root> --apply --report <report.json>

Without --apply the command inspects the store and writes nothing (dry run).
--apply needs the report of a dry run over the same unchanged store: every file
must keep its size and mtime, otherwise nothing is written.

Before the first write the whole store (contexts/ and opencontext.db) is copied
to <store-root>.backup-<UTC>. The migrator registers every unregistered
document, writes stable_id into every file's frontmatter, rewrites abs_path and
verifies the result. It never deletes a store file.

Restore after a failed run: replace the store root with its backup directory.
`;

interface CliOptions {
  readonly store: string;
  readonly apply: boolean;
  readonly reportPath: string | null;
}

type Parsed =
  | { readonly kind: "run"; readonly options: CliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(() => new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest())),
  }),
);

const parseArgs = (args: ReadonlyArray<string>): Parsed => {
  let store: string | undefined;
  let reportPath: string | null = null;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--store" || arg === "--report") {
      const value = args[index + 1];
      if (value === undefined) return { kind: "error", message: `${arg} needs a value.` };
      index += 1;
      if (arg === "--store") store = value;
      else reportPath = value;
      continue;
    }
    if (arg !== undefined && !arg.startsWith("--") && store === undefined) {
      store = arg;
      continue;
    }
    return { kind: "error", message: `Unknown argument "${arg ?? ""}".` };
  }
  if (store === undefined) return { kind: "error", message: "--store <store-root> is required." };
  if (apply && reportPath === null) {
    return { kind: "error", message: "--apply needs --report <report.json> from the dry run." };
  }
  return { kind: "run", options: { store, apply, reportPath } };
};

const label = (path: string): string => `"${path}"`;

const printList = (title: string, values: ReadonlyArray<string>): string => {
  if (values.length === 0) return `${title}: 0\n`;
  const shown = values.slice(0, 20).map((value) => `  ${value}`);
  if (values.length > 20) shown.push(`  ... ${values.length - 20} more`);
  return `${title}: ${values.length}\n${shown.join("\n")}\n`;
};

const formatReport = (report: MigrateStoreReport): string => {
  const lines = [
    `Store: ${label(report.root)}`,
    `Files: ${report.fileCount}; document rows: ${report.documentRowCount}; folder rows: ${report.folderRowCount}`,
    printList("Unregistered files to register", report.unregisteredFiles),
    printList("Files missing stable_id", report.filesWithoutStableId),
    `Files that receive a new frontmatter block: ${report.filesNeedingFrontmatterBlock.length}`,
    printList(
      "Database rows without files",
      report.dbRowsWithoutFiles.map((row) => row.relPath),
    ),
    printList(
      "abs_path rewrites",
      report.absPathRewrites.map((rewrite) => `${rewrite.table} ${rewrite.relPath}`),
    ),
    printList(
      "Duplicate stable ids",
      report.duplicates.map(
        (duplicate) => `${duplicate.stableId}: ${duplicate.relPaths.join(", ")}`,
      ),
    ),
    printList("Dangling oc:// links", report.danglingLinks),
    "Dry run only: nothing was written. Pass this report to --apply after reviewing it.",
  ];
  if (report.warnings.length > 0) lines.push(printList("Warnings", report.warnings));
  return `${lines.join("\n")}\n`;
};

const formatResult = (result: MigrateStoreResult): string => {
  const lines = [
    result.status === "up_to_date"
      ? "The store is already migrated; nothing to write."
      : `Migrated ${result.plan.fileCount} file(s).`,
    `Registered documents: ${result.registeredDocuments.length}`,
    `Frontmatter writes: ${result.frontmatterWrites.length}`,
    `abs_path rewrites: ${result.absPathRewrites.length}`,
    result.backupDirectory === null
      ? "Backup: none (nothing was written)"
      : `Backup: ${result.backupDirectory}`,
    `Verification: ${result.verification.ok ? "passed" : "FAILED"} (${result.verification.checkedFiles} files, ${result.verification.checkedRows} rows)`,
  ];
  for (const issue of result.verification.issues) {
    lines.push(`  issue ${issue.code}: ${issue.detail}`);
  }
  for (const issue of result.verification.warnings) {
    lines.push(`  warning ${issue.code}: ${issue.detail}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (!result.verification.ok) {
    lines.push(
      `Restore the store from ${result.backupDirectory ?? "the last backup"} and run the dry run again.`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const readReport = async (path: string): Promise<MigrateStoreReport> => {
  const text = await NodeFSP.readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isMigrateStoreReport(parsed)) {
    throw new Error(`"${path}" is not a migration report of this migrator.`);
  }
  return parsed;
};

const reconcilerWithDeps = (root: string) =>
  reconcilerLayer({ root }).pipe(
    Layer.provide(
      Layer.merge(
        storeLayer({ root }).pipe(Layer.provide(cryptoLayer)),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );

const run = async (argv: ReadonlyArray<string>): Promise<number> => {
  const parsed = parseArgs(argv);
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${usage}`);
    return 2;
  }
  if (parsed.kind === "help") {
    process.stdout.write(usage);
    return 0;
  }
  const options = parsed.options;
  const root = NodePath.resolve(options.store);

  if (!options.apply) {
    const report = await Effect.runPromise(inspectStore(root));
    process.stdout.write(formatReport(report));
    if (options.reportPath !== null) {
      await NodeFSP.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`Report written to ${label(options.reportPath)}.\n`);
    }
    return 0;
  }

  const report = await readReport(options.reportPath ?? "");
  const program = migrateStore({ root, report }).pipe(Effect.provide(reconcilerWithDeps(root)));
  const result = await Effect.runPromise(program);
  process.stdout.write(formatResult(result));
  return result.verification.ok ? 0 : 1;
};

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 2;
}
