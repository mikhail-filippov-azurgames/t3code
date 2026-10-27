import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_BOARD_ARCHIVE_AFTER_DAYS,
  MAX_BOARD_DELETE_ARCHIVED_AFTER_DAYS,
  MAX_DELETED_THREAD_PURGE_AFTER_DAYS,
  MIN_BOARD_ARCHIVE_AFTER_DAYS,
  MIN_BOARD_DELETE_ARCHIVED_AFTER_DAYS,
  MIN_DELETED_THREAD_PURGE_AFTER_DAYS,
} from "@t3tools/contracts/settings";

import { BoundedIntegerInput } from "./CoordinatorBoardNudgeSettings.tsx";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";

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

export function DeletedThreadPurgeSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const purgeAfterDays = settings.deletedThreadPurgeAfterDays;
  const defaults = DEFAULT_UNIFIED_SETTINGS;
  const isDirty = purgeAfterDays !== defaults.deletedThreadPurgeAfterDays;

  return (
    <SettingsSection id="deleted-thread-purge" title="Deleted thread erasure">
      <SettingsRow
        serverScoped
        settingKeys={["deletedThreadPurgeAfterDays"]}
        {...searchableSetting("deleted-thread-purge")}
        description="Deleted threads are physically erased at server start once they have been deleted this long: their events and every stored row disappear, and the erasure is permanent. Worktrees on disk and provider-side histories are never touched."
        resetAction={
          isDirty ? (
            <SettingResetButton
              label="deleted thread erasure"
              onClick={() =>
                updateSettings({
                  deletedThreadPurgeAfterDays: defaults.deletedThreadPurgeAfterDays,
                })
              }
            />
          ) : null
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["deletedThreadPurgeAfterDays"]}
        title={searchableSetting("deleted-thread-purge-after").title}
        description="Days after deletion before a deleted thread is erased at server start. Erasure is permanent."
        control={
          <BoundedIntegerInput
            value={purgeAfterDays}
            min={MIN_DELETED_THREAD_PURGE_AFTER_DAYS}
            max={MAX_DELETED_THREAD_PURGE_AFTER_DAYS}
            onCommit={(days) => updateSettings({ deletedThreadPurgeAfterDays: days })}
            ariaLabel="Days before a deleted thread is erased"
          />
        }
      />
    </SettingsSection>
  );
}
