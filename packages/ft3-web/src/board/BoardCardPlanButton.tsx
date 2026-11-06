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
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly size?: "xs" | "sm";
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const plan = usePlanThreadSource(environmentId).forCard(cardId);
  if (plan === null) return null;
  return (
    <>
      <Button size={size} variant="outline" onClick={() => setViewerOpen(true)}>
        Plan
      </Button>
      {viewerOpen ? (
        <PlanViewerDialog
          environmentId={environmentId}
          cardId={cardId}
          title={plan.title}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </>
  );
}
