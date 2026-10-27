import type { UsageProviderKind } from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { PROVIDER_PRESENTATION } from "~/components/usage/usageProviders";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { isModelColumnId, MODEL_COLUMN_LABELS, type ModelColumnId } from "./usageModelColumns";
import { useUsageModelColumns } from "./usageModelColumnsPreference";
import {
  modelSortValue,
  sortModels,
  type ModelSortDirection,
  type ModelSortKey,
  type ModelSortMetric,
} from "./usageModelSort";

interface ModelSort {
  readonly key: ModelSortKey;
  readonly direction: ModelSortDirection;
}

const ALL_COLUMNS = Object.keys(MODEL_COLUMN_LABELS) as ModelColumnId[];

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function formatUsdPerMillion(model: ModelTotals): string {
  const value = modelSortValue(model, "pricePerMillion", "cost");
  return value === null ? "—" : formatUsd(value);
}

function ModelCell({
  columnId,
  model,
  metric,
}: {
  readonly columnId: ModelColumnId;
  readonly model: ModelTotals;
  readonly metric: ModelSortMetric;
}) {
  switch (columnId) {
    case "cost":
      return isModelCostUnknown(model) ? (
        <span className="text-muted-foreground">Unpriced</span>
      ) : (
        formatUsd(model.costUsd)
      );
    case "share":
      return metric === "tokens"
        ? formatPercent(model.tokenShare)
        : isModelCostUnknown(model)
          ? "—"
          : formatPercent(model.costShare);
    case "tokens":
      return formatTokens(model.totalTokens);
    case "pricePerMillion":
      return formatUsdPerMillion(model);
    case "sessions":
      return formatCount(model.sessions);
  }
}

function ModelSortHeader({
  columnId,
  activeSort,
  onToggle,
}: {
  readonly columnId: ModelColumnId;
  readonly activeSort: ModelSort;
  readonly onToggle: (key: ModelSortKey) => void;
}) {
  const active = activeSort.key === columnId;
  const Icon = active
    ? activeSort.direction === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon
    : ArrowUpDownIcon;
  return (
    <th
      className="py-2 pl-3 text-right font-normal"
      aria-sort={active ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onToggle(columnId)}
        className={cn(
          "inline-flex cursor-pointer items-center justify-end gap-1 font-normal",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <span>{MODEL_COLUMN_LABELS[columnId]}</span>
        <Icon className={cn("size-3 shrink-0", !active && "opacity-40")} aria-hidden />
      </button>
    </th>
  );
}

export function UsageModelTable({
  models,
  metric,
  loadingProviders,
  onSelectModel,
}: {
  readonly models: readonly ModelTotals[];
  readonly metric: ModelSortMetric;
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly onSelectModel: (key: string) => void;
}) {
  const { columns, setColumns } = useUsageModelColumns();
  const [modelSort, setModelSort] = useState<ModelSort | null>(null);
  const activeSort: ModelSort = modelSort ?? {
    key: metric === "tokens" ? "tokens" : "cost",
    direction: "desc",
  };
  const visibleColumns = ALL_COLUMNS.filter((column) => columns.includes(column));
  const sortedModels = sortModels(models, activeSort.key, activeSort.direction, metric);
  const peak = sortedModels.reduce(
    (value, model) => Math.max(value, metric === "tokens" ? model.totalTokens : model.costUsd),
    0,
  );
  const toggleSort = (key: ModelSortKey) => {
    setModelSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        aria-label="Model columns"
        variant="segmented"
        multiple
        value={[...columns]}
        onValueChange={(next) => setColumns(next.filter(isModelColumnId))}
      >
        {ALL_COLUMNS.map((column) => (
          <Toggle key={column} value={column}>
            {MODEL_COLUMN_LABELS[column]}
          </Toggle>
        ))}
      </ToggleGroup>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-8" />
            <col />
            {visibleColumns.map((column) => (
              <col key={column} className="w-[12%]" />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border text-right text-xs text-muted-foreground">
              <th className="py-2 text-left font-normal">#</th>
              <th className="py-2 text-left font-normal">Model</th>
              {visibleColumns.map((column) => (
                <ModelSortHeader
                  key={column}
                  columnId={column}
                  activeSort={activeSort}
                  onToggle={toggleSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedModels.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleColumns.length + 2}
                  className="py-6 text-center text-muted-foreground"
                >
                  No activity in this window.
                </td>
              </tr>
            ) : (
              sortedModels.map((model, index) => {
                const key = `${model.provider}:${model.model}`;
                const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                const hasBar = value > 0 && peak > 0;
                const rowFigures = figureClass(loadingProviders.has(model.provider));
                return (
                  <tr
                    key={key}
                    className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
                  >
                    <td className={cn("py-2.5 text-left text-xs", rowFigures)}>{index + 1}</td>
                    <td className="py-2.5 pr-3 text-left whitespace-normal">
                      <button
                        type="button"
                        onClick={() => onSelectModel(key)}
                        className={cn(
                          "flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0",
                          !hasBar && "py-1",
                        )}
                      >
                        <ProviderInstanceIcon
                          driverKind={PROVIDER_PRESENTATION[model.provider].driverKind}
                          displayName={PROVIDER_PRESENTATION[model.provider].label}
                          iconClassName="size-3.5"
                        />
                        {model.model}
                      </button>
                      {hasBar ? (
                        <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", rowFigures)}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `max(0.5rem, ${(value / peak) * 100}%)`,
                              backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                            }}
                          />
                        </div>
                      ) : null}
                    </td>
                    {visibleColumns.map((column) => (
                      <td
                        key={column}
                        className={cn(
                          "py-2.5 pl-3",
                          column === "cost" ? "text-foreground" : "text-muted-foreground",
                          rowFigures,
                        )}
                      >
                        <ModelCell columnId={column} model={model} metric={metric} />
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
