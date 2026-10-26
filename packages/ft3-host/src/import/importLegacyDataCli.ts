#!/usr/bin/env node

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import { importLegacyData, type ImportResult } from "./importLegacyData.ts";

const usage = `Usage: node packages/ft3-host/src/import/importLegacyDataCli.ts <database-copy-path>

Imports the legacy fork tables left behind after the first V2 run into the ft3/V2 tables:
  - board_orchestrators/cards/events/deletions -> ft3_board_*
  - coordinator_architect_binding/architecture_review -> ft3_architect_*
  - projection_delegated_task_summaries -> ft3_delegated_task_summaries
  - calendar_events -> scheduled_tasks (daily fixed_time)
  - delegation.created lineage -> orchestration_v2_projection_subagents + thread lineage
`;

const formatCount = (name: string, count: ImportResult[keyof ImportResult]): string => {
  if (typeof count !== "object" || count === null) return "";
  const { source, target, skipped } = count as { source: number; target: number; skipped: number };
  const skip = skipped > 0 ? ` (skipped ${skipped})` : "";
  return `${name}: source ${source} -> target ${target}${skip}`;
};

const main = (): void => {
  const arg = process.argv[2];
  if (arg === undefined || arg === "--help" || arg === "-h") {
    process.stdout.write(usage);
    return;
  }
  const filename = arg;
  Effect.runPromise(
    importLegacyData(filename).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
  ).then(
    (result) => {
      process.stdout.write(
        [
          formatCount("board_orchestrators", result.boardOrchestrators),
          formatCount("board_cards", result.boardCards),
          formatCount("board_card_events", result.boardCardEvents),
          formatCount("board_card_deletions", result.boardCardDeletions),
          formatCount("architect_bindings", result.architectBindings),
          formatCount("architect_reviews", result.architectReviews),
          formatCount("task_summaries", result.taskSummaries),
          formatCount("scheduled_tasks", result.scheduledTasks),
          formatCount("subagents", result.subagents),
          `lineage_restored: ${result.lineageRestored}`,
        ]
          .filter((line) => line !== "")
          .join("\n") + "\n",
      );
      process.stdout.write(`Imported ${filename}.\n`);
    },
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`importLegacyData failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
};

main();
