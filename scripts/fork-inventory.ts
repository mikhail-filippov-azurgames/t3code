#!/usr/bin/env node

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_BASE_REF = "upstream/main";

class ForkInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkInventoryError";
  }
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

async function runGit(args: ReadonlyArray<string>): Promise<GitResult> {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: process.cwd() }));
      const collect = (stream: typeof child.stdout) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        );
      const [stdout, stderr, status] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, status };
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.result),
  );
  if (Result.isFailure(result)) {
    throw new ForkInventoryError(`Failed to run git: ${result.failure.message}`);
  }
  return result.success;
}

async function gitOrThrow(args: ReadonlyArray<string>, context: string): Promise<string> {
  const { stdout, stderr, status } = await runGit(args);
  if (status !== 0) {
    const detail = stderr.trim();
    throw new ForkInventoryError(
      detail.length > 0 ? `${context}: ${detail}` : `${context} (git exited with code ${status}).`,
    );
  }
  return stdout;
}

interface Change {
  readonly status: string;
  readonly path: string;
  readonly oldPath?: string;
}

function parseNameStatus(raw: string): ReadonlyArray<Change> {
  const changes: Array<Change> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    const status = (fields[0] ?? "").charAt(0);
    if (status === "R" || status === "C") {
      const oldPath = fields[1] ?? "";
      const path = fields[2] ?? "";
      changes.push({ status, path, oldPath });
    } else {
      changes.push({ status, path: fields[1] ?? "" });
    }
  }
  return changes;
}

interface Churn {
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
}

function parseNumstat(raw: string): ReadonlyMap<string, Churn> {
  const churn = new Map<string, Churn>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    const path = fields[2] ?? "";
    const added = fields[0] ?? "";
    const deleted = fields[1] ?? "";
    const binary = added === "-" || deleted === "-";
    churn.set(path, {
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return churn;
}

function groupDirectory(path: string): string {
  const parts = path.split("/");
  if (parts.length < 2) return "(root)";
  if (parts[0] === "apps" || parts[0] === "packages") {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? "(root)";
}

function sortPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...paths].toSorted((a, b) => a.localeCompare(b));
}

function renderModified(
  changes: ReadonlyArray<Change>,
  churn: ReadonlyMap<string, Churn>,
): ReadonlyArray<string> {
  const rows = changes.map((change) => {
    const entry = churn.get(change.path);
    const added = entry?.added ?? 0;
    const deleted = entry?.deleted ?? 0;
    return {
      path: change.path,
      added,
      deleted,
      binary: entry?.binary ?? false,
      churn: added + deleted,
    };
  });
  rows.sort((a, b) => b.churn - a.churn || a.path.localeCompare(b.path));

  const lines = [
    "## Modified upstream files (touchpoints)",
    "",
    "Sorted by churn (added + deleted lines). Binary files count as 0.",
    "",
    "| Churn | Added | Deleted | Path |",
    "| ---: | ---: | ---: | :--- |",
  ];
  if (rows.length === 0) {
    lines.push("| 0 | 0 | 0 | _None._ |");
    return lines;
  }
  for (const row of rows) {
    lines.push(
      `| ${row.binary ? "binary" : row.churn} | ${row.binary ? "-" : row.added} | ${
        row.binary ? "-" : row.deleted
      } | \`${row.path}\` |`,
    );
  }
  return lines;
}

function renderAdded(changes: ReadonlyArray<Change>): ReadonlyArray<string> {
  const groups = new Map<string, Array<string>>();
  for (const change of changes) {
    const key = groupDirectory(change.path);
    const bucket = groups.get(key) ?? [];
    bucket.push(change.path);
    groups.set(key, bucket);
  }
  const keys = [...groups.keys()].toSorted((a, b) => a.localeCompare(b));

  const lines = ["## Added files", ""];
  if (keys.length === 0) {
    lines.push("_None._");
    return lines;
  }
  for (const key of keys) {
    const paths = sortPaths(groups.get(key) ?? []);
    lines.push(`### ${key} (${paths.length})`, "");
    for (const path of paths) {
      lines.push(`- \`${path}\``);
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderRenamed(changes: ReadonlyArray<Change>): ReadonlyArray<string> {
  const lines = ["## Renamed upstream files", ""];
  if (changes.length === 0) {
    lines.push("_None._");
    return lines;
  }
  const sorted = [...changes].sort((a, b) => (a.oldPath ?? "").localeCompare(b.oldPath ?? ""));
  for (const change of sorted) {
    lines.push(`- \`${change.oldPath}\` → \`${change.path}\``);
  }
  return lines;
}

function renderDeleted(changes: ReadonlyArray<Change>): ReadonlyArray<string> {
  const lines = ["## Deleted upstream files", ""];
  if (changes.length === 0) {
    lines.push("_None._");
    return lines;
  }
  for (const path of sortPaths(changes.map((change) => change.path))) {
    lines.push(`- \`${path}\``);
  }
  return lines;
}

function renderOther(changes: ReadonlyArray<Change>): ReadonlyArray<string> {
  if (changes.length === 0) return [];
  const lines = ["## Other changes", ""];
  for (const change of sortPaths(changes.map((change) => `${change.status} ${change.path}`))) {
    lines.push(`- \`${change}\``);
  }
  return lines;
}

async function buildInventory(baseRef: string): Promise<string> {
  const verify = await runGit(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (verify.status !== 0) {
    throw new ForkInventoryError(
      `Base ref "${baseRef}" was not found. Pass an existing git ref (default: ${DEFAULT_BASE_REF}).`,
    );
  }

  const mergeBaseResult = await runGit(["merge-base", baseRef, "HEAD"]);
  const mergeBase = mergeBaseResult.stdout.trim();
  if (mergeBaseResult.status !== 0 || mergeBase.length === 0) {
    throw new ForkInventoryError(
      `No merge base between "${baseRef}" and HEAD; the histories are unrelated.`,
    );
  }

  const head = (await gitOrThrow(["rev-parse", "HEAD"], "Failed to resolve HEAD")).trim();
  const leftRight = (
    await gitOrThrow(
      ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`],
      `Failed to compare "${baseRef}" with HEAD`,
    )
  )
    .trim()
    .split(/\s+/);
  const behind = Number(leftRight[0]);
  const ahead = Number(leftRight[1]);

  const nameStatus = parseNameStatus(
    await gitOrThrow(
      ["diff", "--no-ext-diff", "--no-color", "--name-status", "-M", `${mergeBase}..HEAD`],
      "Failed to read the fork delta",
    ),
  );
  const churn = parseNumstat(
    await gitOrThrow(
      ["diff", "--no-ext-diff", "--no-color", "--numstat", "-M", `${mergeBase}..HEAD`],
      "Failed to read the fork delta line counts",
    ),
  );

  const added = nameStatus.filter((change) => change.status === "A");
  const modified = nameStatus.filter((change) => change.status === "M");
  const deleted = nameStatus.filter((change) => change.status === "D");
  const renamed = nameStatus.filter((change) => change.status === "R");
  const other = nameStatus.filter((change) => !["A", "M", "D", "R"].includes(change.status));

  const lines = [
    "# Fork inventory",
    "",
    `- Base ref: \`${baseRef}\``,
    `- Merge base: \`${mergeBase}\``,
    `- HEAD: \`${head}\``,
    `- Commits ahead of base (fork-only): ${ahead}`,
    `- Commits behind base (upstream-only): ${behind}`,
    "",
    "## Summary",
    "",
    `- Added: ${added.length}`,
    `- Modified: ${modified.length}`,
    `- Deleted: ${deleted.length}`,
    `- Renamed: ${renamed.length}`,
    `- Total: ${nameStatus.length}`,
    "",
    ...renderModified(modified, churn),
    "",
    ...renderAdded(added),
    "",
    ...renderRenamed(renamed),
    "",
    ...renderDeleted(deleted),
  ];
  const otherSection = renderOther(other);
  if (otherSection.length > 0) {
    lines.push("", ...otherSection);
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const baseRef = process.argv[2] ?? DEFAULT_BASE_REF;
  process.stdout.write(await buildInventory(baseRef));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fork-inventory: ${message}\n`);
  process.exitCode = 1;
}
