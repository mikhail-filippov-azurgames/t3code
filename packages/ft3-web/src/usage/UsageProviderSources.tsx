import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { ProviderSourceBreakdown } from "@t3tools/shared/usageSourceBreakdown";

import { cn } from "~/lib/utils";

import { usageSourceRows } from "./usageSourceRows.ts";

/** Per-source rows under a provider's total, shown only when a source names its instances. */
export function UsageProviderSources(props: {
  readonly breakdown: ProviderSourceBreakdown | undefined;
  readonly metric: "tokens" | "cost";
  readonly loading: boolean;
}) {
  const rows = usageSourceRows(props.breakdown);
  if (rows.length === 0) return null;
  return (
    <ul
      data-ft3-usage-sources=""
      className={cn("flex flex-col gap-0.5 pl-6", props.loading && "opacity-60")}
    >
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground"
        >
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("truncate", !row.unattributed && "text-foreground/80")}>
              {row.label}
            </span>
            <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums">
              {formatCount(row.sessions)} {row.sessions === 1 ? "session" : "sessions"}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">
            {props.metric === "cost" ? formatUsd(row.costUsd) : formatTokens(row.totalTokens)}
          </span>
        </li>
      ))}
    </ul>
  );
}
