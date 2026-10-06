import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, ...state.settings }),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: `title:${id}` }),
}));
vi.mock("./settingsLayout", () => ({
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{`Reset ${label}`}</button>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => children,
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
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

import { CoordinatorBoardNudgeSection } from "./CoordinatorBoardNudgeSettings";

const SWITCH = "Nudge idle coordinators toward board cards";
const INTERVAL = "Minutes between coordinator board checks";
const THRESHOLD = "Active child tasks that count as busy";

let renderer: ReactTestRenderer | null;

function render() {
  act(() => {
    renderer = create(<CoordinatorBoardNudgeSection />);
  });
}

function control(label: string) {
  return renderer!.root.findAll(
    (node) => node.type === "input" && node.props["aria-label"] === label,
  );
}

function type(label: string, value: string) {
  act(() => control(label)[0]!.props.onChange({ target: { value } }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = {};
  state.updateSettings.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("coordinator board nudge settings", () => {
  it("shows an off switch and says that enabling lets coordinators take cards on their own", () => {
    render();

    expect(control(SWITCH)[0]!.props.checked).toBe(false);
    expect(control(INTERVAL)).toHaveLength(0);
    expect(control(THRESHOLD)).toHaveLength(0);
    const text = renderer!.root
      .findAllByType("p")
      .flatMap((node) => node.children)
      .join(" ");
    expect(text).toContain("Off by default");
    expect(text).toContain("starts new work on its own, without anyone asking it to");
  });

  it("turns on with a starting interval and turns off with null", () => {
    render();
    act(() => control(SWITCH)[0]!.props.onCheckedChange(true));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      coordinatorBoardNudgeIntervalMinutes: 15,
    });

    state.settings = { coordinatorBoardNudgeIntervalMinutes: 15 };
    render();
    act(() => control(SWITCH)[0]!.props.onCheckedChange(false));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      coordinatorBoardNudgeIntervalMinutes: null,
    });
  });

  it("shows both fields with the stored values once enabled", () => {
    state.settings = {
      coordinatorBoardNudgeIntervalMinutes: 30,
      coordinatorBoardNudgeActiveChildThreshold: 2,
    };
    render();

    expect(control(SWITCH)[0]!.props.checked).toBe(true);
    expect(control(INTERVAL)[0]!.props.value).toBe("30");
    expect(control(THRESHOLD)[0]!.props.value).toBe("2");
  });

  it("saves only values the schema accepts", () => {
    state.settings = { coordinatorBoardNudgeIntervalMinutes: 30 };
    render();

    for (const invalid of ["", "4", "0", "-5", "7.5", "1441", "abc"]) type(INTERVAL, invalid);
    for (const invalid of ["", "0", "-1", "1.5", "21"]) type(THRESHOLD, invalid);
    expect(state.updateSettings).not.toHaveBeenCalled();

    type(INTERVAL, "45");
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      coordinatorBoardNudgeIntervalMinutes: 45,
    });
    type(THRESHOLD, "3");
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      coordinatorBoardNudgeActiveChildThreshold: 3,
    });
  });

  it("restores the persisted value when an invalid draft is abandoned", () => {
    state.settings = { coordinatorBoardNudgeIntervalMinutes: 30 };
    render();

    type(INTERVAL, "");
    expect(control(INTERVAL)[0]!.props.value).toBe("");
    act(() => control(INTERVAL)[0]!.props.onBlur());
    expect(control(INTERVAL)[0]!.props.value).toBe("30");
  });

  it("offers a reset to off only when something differs from the default", () => {
    render();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    act(() => renderer!.unmount());
    state.settings = {
      coordinatorBoardNudgeIntervalMinutes: 30,
      coordinatorBoardNudgeActiveChildThreshold: 2,
    };
    render();
    act(() => renderer!.root.findByType("button").props.onClick());
    expect(state.updateSettings).toHaveBeenCalledWith({
      coordinatorBoardNudgeIntervalMinutes: null,
      coordinatorBoardNudgeActiveChildThreshold: 1,
    });
  });
});
