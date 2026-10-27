import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_BOARD_AUTOMATION_SETTINGS } from "@t3tools/ft3-board/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  update: vi.fn(),
}));

vi.mock("~/components/settings/useScopedSettings", () => ({
  useScopedSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, ...mocks.settings }),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => mocks.update,
}));
vi.mock("~/components/settings/settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: `title:${id}` }),
}));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>{`Reset ${label}`}</button>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    description,
    control,
    resetAction,
  }: {
    description: ReactNode;
    control: ReactNode;
    resetAction: ReactNode;
  }) => (
    <div>
      <p>{description}</p>
      {control}
      {resetAction}
    </div>
  ),
}));

import { BoardRetentionSection, DeletedThreadPurgeSection } from "./BoardRetentionSettings.tsx";

const ARCHIVE = "Days before a finished card is archived";
const DELETE = "Days before an archived finished card is deleted";
const PURGE = "Days before a deleted thread is erased";

describe("board retention settings", () => {
  it("defaults to 1 day before archive and 14 days before deletion", async () => {
    mocks.settings = {};
    await using screen = await render(<BoardRetentionSection />, { router: false });
    expect(DEFAULT_BOARD_AUTOMATION_SETTINGS.boardArchiveAfterDays).toBe(1);
    expect(DEFAULT_BOARD_AUTOMATION_SETTINGS.boardDeleteArchivedAfterDays).toBe(14);
    expect((screen.getByLabelText(ARCHIVE).element() as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText(DELETE).element() as HTMLInputElement).value).toBe("14");
    expect(screen.container.querySelectorAll("button").length).toBe(0);
  });

  it("says unfinished cards are never touched and deletion is permanent", async () => {
    mocks.settings = {};
    await using screen = await render(<BoardRetentionSection />, { router: false });
    expect(screen.container.textContent).toContain(
      "Backlog and unfinished cards are never touched",
    );
    expect(screen.container.textContent).toContain("Deletion is permanent");
    expect(screen.container.textContent).toContain("next hourly pass");
  });

  it("shows stored values and saves only accepted values", async () => {
    mocks.settings = { ft3: { boardArchiveAfterDays: 7, boardDeleteArchivedAfterDays: 30 } };
    mocks.update.mockReset();
    await using screen = await render(<BoardRetentionSection />, { router: false });
    const archive = screen.getByLabelText(ARCHIVE);
    const remove = screen.getByLabelText(DELETE);
    expect((archive.element() as HTMLInputElement).value).toBe("7");
    expect((remove.element() as HTMLInputElement).value).toBe("30");

    await userEvent.clear(archive);
    await userEvent.type(archive, "-1");
    await userEvent.tab();
    expect(mocks.update).not.toHaveBeenCalled();
    expect((archive.element() as HTMLInputElement).value).toBe("7");
  });

  it("offers a reset to the defaults only when something differs", async () => {
    mocks.settings = { ft3: { boardArchiveAfterDays: 7, boardDeleteArchivedAfterDays: 30 } };
    mocks.update.mockReset();
    await using screen = await render(<BoardRetentionSection />, { router: false });
    await userEvent.click(screen.getByRole("button"));
    expect(mocks.update).toHaveBeenCalledWith({
      ft3: { boardArchiveAfterDays: 1, boardDeleteArchivedAfterDays: 14 },
    });
  });
});

describe("deleted thread purge settings", () => {
  it("defaults to 14 days and says erasure is permanent", async () => {
    mocks.settings = {};
    await using screen = await render(<DeletedThreadPurgeSection />, { router: false });
    expect(DEFAULT_BOARD_AUTOMATION_SETTINGS.deletedThreadPurgeAfterDays).toBe(14);
    expect((screen.getByLabelText(PURGE).element() as HTMLInputElement).value).toBe("14");
    expect(screen.container.textContent).toContain("erasure is permanent");
    expect(screen.container.textContent).toContain(
      "Worktrees on disk and provider-side histories are never touched",
    );
  });

  it("offers a reset to the default only when it differs", async () => {
    mocks.settings = { ft3: { deletedThreadPurgeAfterDays: 30 } };
    mocks.update.mockReset();
    await using screen = await render(<DeletedThreadPurgeSection />, { router: false });
    await userEvent.click(screen.getByRole("button"));
    expect(mocks.update).toHaveBeenCalledWith({ ft3: { deletedThreadPurgeAfterDays: 14 } });
  });
});
