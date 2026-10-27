import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_BOARD_AUTOMATION_SETTINGS, readBoardAutomationSettings } from "./settings.ts";

describe("readBoardAutomationSettings", () => {
  it("defaults when the namespace is absent or empty", () => {
    expect(readBoardAutomationSettings(undefined)).toEqual(DEFAULT_BOARD_AUTOMATION_SETTINGS);
    expect(readBoardAutomationSettings({})).toEqual(DEFAULT_BOARD_AUTOMATION_SETTINGS);
  });

  it("decodes stored values and fills the missing ones", () => {
    expect(readBoardAutomationSettings({ boardArchiveAfterDays: 7 })).toEqual({
      ...DEFAULT_BOARD_AUTOMATION_SETTINGS,
      boardArchiveAfterDays: 7,
    });
  });

  it("falls back to defaults instead of failing on a corrupt namespace", () => {
    expect(readBoardAutomationSettings({ boardArchiveAfterDays: 0 })).toEqual(
      DEFAULT_BOARD_AUTOMATION_SETTINGS,
    );
    expect(readBoardAutomationSettings({ coordinatorBoardNudgeIntervalMinutes: "nope" })).toEqual(
      DEFAULT_BOARD_AUTOMATION_SETTINGS,
    );
  });
});
