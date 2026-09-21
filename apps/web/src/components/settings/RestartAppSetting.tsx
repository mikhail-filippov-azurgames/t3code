import { useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Restarting is a desktop-shell capability; the browser build has no process
// to restart, so the section stays hidden there.
export function RestartAppSetting() {
  const [isRestarting, setIsRestarting] = useState(false);
  if (!isElectron) return null;

  const restart = async () => {
    setIsRestarting(true);
    try {
      await readLocalApi()?.restartApp();
    } catch (cause) {
      setIsRestarting(false);
      toastManager.add({
        type: "error",
        title: "Couldn't restart the app",
        description: cause instanceof Error ? cause.message : "Restart failed.",
      });
    }
  };

  return (
    <SettingsSection id="application" title="Application">
      <SettingsRow
        title="Restart app"
        description="Threads continue after the app restarts."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={isRestarting}
            onClick={() => void restart()}
          >
            {isRestarting ? "Restarting…" : "Restart app"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
