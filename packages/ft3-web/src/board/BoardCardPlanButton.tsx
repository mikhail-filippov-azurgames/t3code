import type { EnvironmentId } from "@t3tools/contracts";
import type { BoardCardId } from "@t3tools/ft3-board/contracts";

import { Button } from "~/components/ui/button";
import { usePlanThreadSource } from "../lineage/usePlanThreadSource.ts";

export function BoardCardPlanButton({
  environmentId,
  cardId,
  size = "xs",
  onOpenPlan,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly size?: "xs" | "sm";
  readonly onOpenPlan: (cardId: BoardCardId) => void;
}) {
  const plan = usePlanThreadSource(environmentId).forCard(cardId);
  if (plan === null) return null;
  return (
    <Button size={size} variant="outline" onClick={() => onOpenPlan(cardId)}>
      Plan
    </Button>
  );
}
