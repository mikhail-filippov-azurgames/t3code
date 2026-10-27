import { SwitchProviderDialogHost } from "./SwitchProviderDialog";
import { ThreadChildrenDialogHost } from "./ThreadChildrenDialogHost";

/** Single mount point for the delegation dialogs the thread menu opens. */
export function DelegationDialogHosts() {
  return (
    <>
      <ThreadChildrenDialogHost />
      <SwitchProviderDialogHost />
    </>
  );
}
