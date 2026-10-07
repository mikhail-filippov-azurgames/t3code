import {
  MAX_BOARD_ARCHIVE_AFTER_DAYS,
  MAX_BOARD_DELETE_ARCHIVED_AFTER_DAYS,
  MIN_BOARD_ARCHIVE_AFTER_DAYS,
  MIN_BOARD_DELETE_ARCHIVED_AFTER_DAYS,
  DEFAULT_UNIFIED_SETTINGS,
} from "@t3tools/contracts/settings";

import { BoundedIntegerInput } from "./CoordinatorBoardNudgeSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function BoardRetentionSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const archiveAfterDays = settings.boardArchiveAfterDays;
  const deleteAfterDays = settings.boardDeleteArchivedAfterDays;
  const defaults = DEFAULT_UNIFIED_SETTINGS;
  const isDirty =
    archiveAfterDays !== defaults.boardArchiveAfterDays ||
    deleteAfterDays !== defaults.boardDeleteArchivedAfterDays;

  return (
    <SettingsSection id="board-retention" title="Board archive & deletion">
      <SettingsRow
        serverScoped
        settingKeys={["boardArchiveAfterDays", "boardDeleteArchivedAfterDays"]}
        {...searchableSetting("board-retention")}
        description="Finished cards archive themselves once nobody touches them, and archived finished cards are deleted with their history after their retention period. Backlog and unfinished cards are never touched."
        resetAction={
          isDirty ? (
            <SettingResetButton
              label="board archive and deletion"
              onClick={() =>
                updateSettings({
                  boardArchiveAfterDays: defaults.boardArchiveAfterDays,
                  boardDeleteArchivedAfterDays: defaults.boardDeleteArchivedAfterDays,
                })
              }
            />
          ) : null
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["boardArchiveAfterDays"]}
        title={searchableSetting("board-retention-archive-after").title}
        description="Days after its last change before a finished card is archived."
        control={
          <BoundedIntegerInput
            value={archiveAfterDays}
            min={MIN_BOARD_ARCHIVE_AFTER_DAYS}
            max={MAX_BOARD_ARCHIVE_AFTER_DAYS}
            onCommit={(days) => updateSettings({ boardArchiveAfterDays: days })}
            ariaLabel="Days before a finished card is archived"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["boardDeleteArchivedAfterDays"]}
        title={searchableSetting("board-retention-delete-after").title}
        description="Days after archival before an archived finished card is deleted with its history. Deletion is permanent. Lowering this can make cards deletable on the next hourly pass."
        control={
          <BoundedIntegerInput
            value={deleteAfterDays}
            min={MIN_BOARD_DELETE_ARCHIVED_AFTER_DAYS}
            max={MAX_BOARD_DELETE_ARCHIVED_AFTER_DAYS}
            onCommit={(days) => updateSettings({ boardDeleteArchivedAfterDays: days })}
            ariaLabel="Days before an archived finished card is deleted"
          />
        }
      />
    </SettingsSection>
  );
}
