import { BoardRetentionSection, DeletedThreadPurgeSection } from "./BoardRetentionSettings.tsx";
import { CoordinatorBoardNudgeSection } from "./CoordinatorBoardNudgeSettings.tsx";

/** Single upstream mount for every fork-owned General settings section. */
export function Ft3GeneralSettingsSections() {
  return (
    <>
      <CoordinatorBoardNudgeSection />
      <BoardRetentionSection />
      <DeletedThreadPurgeSection />
    </>
  );
}
