import { ChevronDownIcon, CircleDashedIcon, CornerDownRightIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { BoardRoleIcon, OrchestratorIcon, ORCHESTRATOR_ICON_CLASS } from "./boardRoleIcons.tsx";
import type { SidebarRoleBadge } from "./roleBadges.ts";

/** Per-row forest + role model the sidebar passes back from `useSidebarForests`. */
export type SidebarForestRowModel = {
  readonly key: string;
  readonly depth: number;
  readonly descendantCount: number;
  readonly collapsed: boolean;
  /** Present when the row has children and can toggle the forest. */
  readonly toggleKey: string | null;
  readonly workingCount: number;
  readonly returnedCount: number;
  readonly roleBadge: SidebarRoleBadge | null;
};

/**
 * Single decoration slot for a sidebar thread row: role badge, delegated
 * child counters (returned / working), collapsed descendant count, and the
 * forest collapse toggle. Rendered by the sidebar inside the row's own flex
 * line via the row's `decorations` prop; indentation itself is the row's
 * `depth` prop.
 */
export function SidebarForestRowDecorations(props: {
  readonly model: SidebarForestRowModel | undefined;
  readonly onToggleCollapse: (key: string) => void;
}) {
  const model = props.model;
  if (model === undefined) return null;
  const badge = model.roleBadge;
  return (
    <>
      {badge !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badge.label}
                className={cn("inline-flex shrink-0 items-center", ORCHESTRATOR_ICON_CLASS)}
              />
            }
          >
            {badge.kind === "orchestrator" ? (
              <OrchestratorIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <BoardRoleIcon role={badge.role} className="size-3.5 shrink-0" />
            )}
          </TooltipTrigger>
          <TooltipPopup>{badge.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {model.returnedCount > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={
                  model.returnedCount === 1
                    ? "1 delegated subtask finished"
                    : `${model.returnedCount} delegated subtasks finished`
                }
                data-testid={`sidebar-delegated-children-returned-${model.key}`}
                className="inline-flex shrink-0 items-center gap-0.5 font-medium text-emerald-600 tabular-nums dark:text-emerald-300/90"
              />
            }
          >
            <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
            <span aria-hidden className="text-[11px]">
              {model.returnedCount}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {model.returnedCount === 1
              ? "1 delegated subtask finished"
              : `${model.returnedCount} delegated subtasks finished`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {model.workingCount > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={
                  model.workingCount === 1
                    ? "1 delegated subtask working"
                    : `${model.workingCount} delegated subtasks working`
                }
                data-testid={`sidebar-delegated-children-working-${model.key}`}
                className="inline-flex shrink-0 items-center gap-0.5 font-medium text-sky-600 tabular-nums dark:text-sky-400"
              />
            }
          >
            <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
            <span aria-hidden className="text-[11px]">
              {model.workingCount}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {model.workingCount === 1
              ? "1 delegated subtask working"
              : `${model.workingCount} delegated subtasks working`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {model.toggleKey !== null && model.collapsed && model.descendantCount > 0 ? (
        <span aria-hidden className="shrink-0 text-xs tabular-nums text-muted-foreground/65">
          ·{model.descendantCount}
        </span>
      ) : null}
      {model.toggleKey !== null ? (
        <button
          type="button"
          aria-label={
            model.collapsed
              ? `Expand ${model.descendantCount} subtasks`
              : `Collapse ${model.descendantCount} subtasks`
          }
          aria-expanded={!model.collapsed}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleCollapse(model.toggleKey!);
          }}
          className="inline-flex shrink-0 cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", model.collapsed && "-rotate-90")}
          />
        </button>
      ) : null}
    </>
  );
}
