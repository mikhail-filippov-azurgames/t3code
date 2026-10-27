import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
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
vi.mock("~/components/settings/ScopedSwitch", () => ({
  ScopedSwitch: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import { CoordinatorBoardNudgeSection } from "./CoordinatorBoardNudgeSettings.tsx";

const SWITCH = "Nudge idle coordinators toward board cards";
const INTERVAL = "Minutes between coordinator board checks";
const THRESHOLD = "Active child tasks that count as busy";

describe("coordinator board nudge settings", () => {
  it("shows an off switch and says enabling lets coordinators take cards", async () => {
    mocks.settings = {};
    await using screen = await render(<CoordinatorBoardNudgeSection />, { router: false });
    expect((screen.getByLabelText(SWITCH).element() as HTMLInputElement).checked).toBe(false);
    expect(screen.container.querySelector(`[aria-label="${INTERVAL}"]`)).toBeNull();
    expect(screen.container.querySelector(`[aria-label="${THRESHOLD}"]`)).toBeNull();
    expect(screen.container.textContent).toContain("Off by default");
    expect(screen.container.textContent).toContain(
      "starts new work on its own, without anyone asking it to",
    );
  });

  it("turns on with a starting interval and off with null", async () => {
    mocks.settings = {};
    mocks.update.mockReset();
    await using screen = await render(<CoordinatorBoardNudgeSection />, { router: false });
    await userEvent.click(screen.getByLabelText(SWITCH));
    expect(mocks.update).toHaveBeenLastCalledWith({
      ft3: { coordinatorBoardNudgeIntervalMinutes: 15 },
    });
  });

  it("shows both fields with stored values once enabled", async () => {
    mocks.settings = {
      ft3: {
        coordinatorBoardNudgeIntervalMinutes: 30,
        coordinatorBoardNudgeActiveChildThreshold: 2,
      },
    };
    await using screen = await render(<CoordinatorBoardNudgeSection />, { router: false });
    expect((screen.getByLabelText(SWITCH).element() as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(INTERVAL).element() as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText(THRESHOLD).element() as HTMLInputElement).value).toBe("2");
  });

  it("saves only values the schema accepts", async () => {
    mocks.settings = { ft3: { coordinatorBoardNudgeIntervalMinutes: 30 } };
    mocks.update.mockReset();
    await using screen = await render(<CoordinatorBoardNudgeSection />, { router: false });
    const interval = screen.getByLabelText(INTERVAL);
    await userEvent.clear(interval);
    await userEvent.type(interval, "4");
    await userEvent.tab();
    expect(mocks.update).not.toHaveBeenCalled();

    await userEvent.clear(interval);
    await userEvent.type(interval, "45");
    expect(mocks.update).toHaveBeenLastCalledWith({
      ft3: { coordinatorBoardNudgeIntervalMinutes: 45 },
    });
  });

  it("offers a reset to off only when something differs from the default", async () => {
    mocks.settings = {
      ft3: {
        coordinatorBoardNudgeIntervalMinutes: 30,
        coordinatorBoardNudgeActiveChildThreshold: 2,
      },
    };
    mocks.update.mockReset();
    await using screen = await render(<CoordinatorBoardNudgeSection />, { router: false });
    await userEvent.click(screen.getByRole("button"));
    expect(mocks.update).toHaveBeenCalledWith({
      ft3: {
        coordinatorBoardNudgeIntervalMinutes: null,
        coordinatorBoardNudgeActiveChildThreshold: 1,
      },
    });
  });
});
