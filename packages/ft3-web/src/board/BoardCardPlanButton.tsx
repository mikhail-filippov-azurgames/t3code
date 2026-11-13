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
  readonly onOpenPlan?: ((cardId: BoardCardId) => void) | undefined;
}) {
  const [selectedPlanId, setSelectedPlanId] = useState<BoardCardId | null>(null);
  const plan = usePlanThreadSource(environmentId).forCard(cardId);
  return (
    <>
      {plan === null ? null : (
        <Button
          size={size}
          variant="outline"
          onClick={() => (onOpenPlan ?? setSelectedPlanId)(cardId)}
        >
          Plan
        </Button>
      )}
      {selectedPlanId !== null ? (
        <PlanViewerDialog
          environmentId={environmentId}
          cardId={selectedPlanId}
          title={plan?.title}
          onClose={() => setSelectedPlanId(null)}
        />
      ) : null}
    </>
  );
}
