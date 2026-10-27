import { useEffect, useState } from "react";
import {
  DEFAULT_BOARD_AUTOMATION_SETTINGS,
  MAX_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD,
  MAX_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES,
  MIN_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD,
  MIN_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES,
  readBoardAutomationSettings,
} from "@t3tools/ft3-board/settings";

import { Input } from "~/components/ui/input";
import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { ft3SearchableSetting } from "./searchItems.ts";

const ENABLE_DEFAULT_INTERVAL_MINUTES = 15;

export function BoundedIntegerInput({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      size="sm"
      type="number"
      min={min}
      max={max}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" and "" must be rejected, not committed.
        const parsed = event.target.value.trim() === "" ? Number.NaN : Number(event.target.value);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={ariaLabel}
    />
  );
}

export function CoordinatorBoardNudgeSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const automation = readBoardAutomationSettings(settings.ft3);
  const interval = automation.coordinatorBoardNudgeIntervalMinutes;
  const threshold = automation.coordinatorBoardNudgeActiveChildThreshold;
  const defaults = DEFAULT_BOARD_AUTOMATION_SETTINGS;
  const isDirty =
    interval !== defaults.coordinatorBoardNudgeIntervalMinutes ||
    threshold !== defaults.coordinatorBoardNudgeActiveChildThreshold;

  return (
    <SettingsSection id="coordinators" title="Coordinators">
      <SettingsRow
        serverScoped
        settingKeys={["ft3"]}
        {...ft3SearchableSetting("coordinator-board-nudge")}
        description="Off by default. When on, the server periodically checks each coordinator, and one that is not busy enough is sent a message to take a card from the board. The coordinator then starts new work on its own, without anyone asking it to."
        resetAction={
          isDirty ? (
            <SettingResetButton
              label="coordinator board nudge"
              onClick={() =>
                updateSettings({
                  ft3: {
                    coordinatorBoardNudgeIntervalMinutes:
                      defaults.coordinatorBoardNudgeIntervalMinutes,
                    coordinatorBoardNudgeActiveChildThreshold:
                      defaults.coordinatorBoardNudgeActiveChildThreshold,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["ft3"]}
            checked={interval !== null}
            onCheckedChange={(checked) =>
              updateSettings({
                ft3: {
                  coordinatorBoardNudgeIntervalMinutes: checked
                    ? ENABLE_DEFAULT_INTERVAL_MINUTES
                    : null,
                },
              })
            }
            aria-label="Nudge idle coordinators toward board cards"
          />
        }
      />
      {interval !== null ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["ft3"]}
            title={ft3SearchableSetting("coordinator-board-nudge-interval").title}
            description="Minutes between checks."
            control={
              <BoundedIntegerInput
                value={interval}
                min={MIN_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES}
                max={MAX_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES}
                onCommit={(minutes) =>
                  updateSettings({ ft3: { coordinatorBoardNudgeIntervalMinutes: minutes } })
                }
                ariaLabel="Minutes between coordinator board checks"
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["ft3"]}
            title={ft3SearchableSetting("coordinator-board-nudge-threshold").title}
            description="A coordinator with fewer active child tasks than this is nudged. 1 nudges only a coordinator with no child tasks."
            control={
              <BoundedIntegerInput
                value={threshold}
                min={MIN_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD}
                max={MAX_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD}
                onCommit={(count) =>
                  updateSettings({ ft3: { coordinatorBoardNudgeActiveChildThreshold: count } })
                }
                ariaLabel="Active child tasks that count as busy"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
