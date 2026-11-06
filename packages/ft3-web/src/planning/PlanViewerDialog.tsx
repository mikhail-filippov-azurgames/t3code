import type { EnvironmentId } from "@t3tools/contracts";
import type { BoardCardId } from "@t3tools/ft3-board/contracts";
import type { PlanRecord } from "@t3tools/ft3-board/planning-contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PLAN_STATE_LABELS, planAcceptAvailable, planFailureView } from "./planViewer.logic.ts";
import { planningEnvironment } from "./state.ts";

/**
 * The card's plan viewer (design §11.2 step 7): the live plan document, its
 * state and a way into the planner thread. «Plan accepted» accepts exactly the
 * digest shown, so a stale view fails with `plan_changed` and reloads.
 */
export function PlanViewerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const { environmentId, cardId } = props;
  const navigate = useNavigate();
  const planGetQuery = useEnvironmentQuery(
    planningEnvironment.planGet({ environmentId, input: { cardId } }),
  );
  const record = planGetQuery.data?.record ?? null;
  const doc = planGetQuery.data?.doc ?? null;
  const readDocQuery = useEnvironmentQuery(
    doc === null
      ? null
      : planningEnvironment.readDoc({ environmentId, input: { ref: doc.stableId } }),
  );
  const acceptCommand = useAtomCommand(planningEnvironment.planAccept, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<PlanRecord | null>(null);

  const state = accepted?.state ?? record?.state ?? null;
  const shownSha256 = readDocQuery.data?.status === "found" ? readDocQuery.data.sha256 : null;
  const canAccept = planAcceptAvailable(state) && shownSha256 !== null && !busy;

  const accept = async () => {
    if (shownSha256 === null) return;
    setBusy(true);
    setError(null);
    const result = await acceptCommand({
      environmentId,
      input: { cardId, sha256: shownSha256 },
    });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const failure = planFailureView(squashAtomCommandFailure(result));
      setError(failure.text);
      if (failure.changed) {
        void readDocQuery.refresh();
        void planGetQuery.refresh();
      }
      return;
    }
    setAccepted(result.value);
    void planGetQuery.refresh();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{`Plan: ${props.title}`}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2">
            <span>{state === null ? "Loading the plan state…" : PLAN_STATE_LABELS[state]}</span>
            {doc === null ? null : <span>{`· ${doc.name}`}</span>}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-3 text-base sm:text-sm">
          {planGetQuery.isPending || readDocQuery.isPending ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading plan…
            </p>
          ) : readDocQuery.data?.status === "found" ? (
            <pre className="max-h-96 min-h-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card px-3 py-2 text-xs leading-relaxed select-text">
              {readDocQuery.data.content}
            </pre>
          ) : (
            <p role="alert" className="text-xs text-muted-foreground">
              Could not load the plan document.
            </p>
          )}
          {error === null ? null : (
            <p
              role="alert"
              className="rounded-md border border-destructive/32 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          {record?.plannerThreadId != null ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: record.plannerThreadId! },
                })
              }
            >
              Open planner thread
            </Button>
          ) : null}
        </DialogPanel>
        <DialogFooter className="flex-row items-center justify-between">
          <Button type="button" disabled={!canAccept} onClick={() => void accept()}>
            Plan accepted
          </Button>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
