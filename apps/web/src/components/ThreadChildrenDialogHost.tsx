import { useEffect } from "react";

import {
  respondToThreadChildrenDialog,
  useThreadChildrenDialogRequest,
} from "../threadChildrenDialog";
import { delegatedChildrenDialogMessage } from "./threadActionMenu.logic";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

/**
 * Yes / No / dismiss confirmation for a parent thread that has delegated
 * children. Esc and the close button resolve "dismissed", which leaves both
 * the parent and its children untouched.
 */
export function ThreadChildrenDialogHost() {
  const request = useThreadChildrenDialogRequest();

  useEffect(() => () => respondToThreadChildrenDialog("dismissed"), []);

  if (!request) return null;

  const verb = request.action === "delete" ? "delete" : "archive";
  const unit = request.childCount === 1 ? "delegated subtask" : "delegated subtasks";
  const description =
    request.action === "delete"
      ? `The ${unit} are deleted first, then the parent. Their conversation history is cleared permanently.`
      : `The ${unit} are archived to Settings > Archived threads first, then the parent.`;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) respondToThreadChildrenDialog("dismissed");
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{delegatedChildrenDialogMessage(request)}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => respondToThreadChildrenDialog("no")}>
            {`No, ${verb} parent only`}
          </Button>
          <Button
            variant={request.action === "delete" ? "destructive" : "default"}
            onClick={() => respondToThreadChildrenDialog("yes")}
          >
            {`Yes, ${verb} together`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
