import type { EnvironmentId } from "@t3tools/contracts";
import type { BoardCardId } from "@t3tools/ft3-board/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { usePlanThreadSource } from "../lineage/usePlanThreadSource.ts";
import { PlanViewerDialog } from "../planning/PlanViewerDialog.tsx";

export function BoardCardPlanButton({
  environmentId,
  cardId,
  size = "xs",
  onOpenPlan,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly size?: "xs" | "sm";
  readonly onOpenPlan?: (plan: { cardId: BoardCardId; title: string }) => void;
}) {
  const [selectedPlan, setSelectedPlan] = useState<{ cardId: BoardCardId; title: string } | null>(
    null,
  );
  const plan = usePlanThreadSource(environmentId).forCard(cardId);
  return (
    <>
      {plan === null ? null : (
        <Button size={size} variant="outline" onClick={() => (onOpenPlan ?? setSelectedPlan)(plan)}>
          Plan
        </Button>
      )}
      {selectedPlan !== null ? (
        <PlanViewerDialog
          environmentId={environmentId}
          cardId={selectedPlan.cardId}
          title={selectedPlan.title}
          onClose={() => setSelectedPlan(null)}
        />
      ) : null}
    </>
  );
}
