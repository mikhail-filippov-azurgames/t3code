import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ClipboardListIcon } from "lucide-react";

import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "~/components/chat/threadDetailsPanelStyles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { PinnedPlanRow } from "./planLineage.logic.ts";

export function PlanLineageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: PinnedPlanRow;
}) {
  const navigate = useNavigate();
  const { plan, label } = props.row;
  const title = `Plan: ${plan.title}`;
  return (
    <li className="group relative flex h-8 items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: props.environmentId, threadId: plan.plannerThreadId },
                })
              }
            />
          }
        >
          <ClipboardListIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
              {title}
            </span>
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">{label}</span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          <span className="block font-medium">{title}</span>
          <span className="block text-muted-foreground">Open the planner thread</span>
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}
