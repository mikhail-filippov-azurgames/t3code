import type { EnvironmentId } from "@t3tools/contracts";
import type { BoardCardId } from "@t3tools/ft3-board/contracts";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { usePlanThreadSource } from "../lineage/planThreadSource.ts";

export function BoardCardPlanButton({
  environmentId,
  cardId,
  size = "xs",
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly size?: "xs" | "sm";
}) {
  const navigate = useNavigate();
  const plan = usePlanThreadSource().forCard(cardId);
  if (plan === null) return null;
  const plannerThreadId = plan.plannerThreadId;
  return (
    <Button
      size={size}
      variant="outline"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: plannerThreadId },
        })
      }
    >
      Plan
    </Button>
  );
}
