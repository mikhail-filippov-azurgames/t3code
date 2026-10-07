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
vi.mock("../ui/input", () => ({ Input: "input" }));

import { BoardRetentionSection, DeletedThreadPurgeSection } from "./BoardRetentionSettings";

const ARCHIVE = "Days before a finished card is archived";
const DELETE = "Days before an archived finished card is deleted";
const PURGE = "Days before a deleted thread is erased";

let renderer: ReactTestRenderer | null;

function render() {
  act(() => {
    renderer = create(<BoardRetentionSection />);
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

function text() {
  return renderer!.root
    .findAllByType("p")
    .flatMap((node) => node.children)
    .join(" ");
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

describe("board retention settings", () => {
  it("defaults to 1 day before archive and 14 days before deletion", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.boardArchiveAfterDays).toBe(1);
    expect(DEFAULT_UNIFIED_SETTINGS.boardDeleteArchivedAfterDays).toBe(14);
    render();

    expect(control(ARCHIVE)[0]!.props.value).toBe("1");
    expect(control(DELETE)[0]!.props.value).toBe("14");
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  });

  it("says unfinished cards are never touched and deletion is permanent", () => {
    render();

    expect(text()).toContain("Backlog and unfinished cards are never touched");
    expect(text()).toContain("Deletion is permanent");
    expect(text()).toContain("next hourly pass");
  });

  it("shows the stored values", () => {
    state.settings = { boardArchiveAfterDays: 7, boardDeleteArchivedAfterDays: 30 };
    render();

    expect(control(ARCHIVE)[0]!.props.value).toBe("7");
    expect(control(DELETE)[0]!.props.value).toBe("30");
  });

  it("saves only values the schema accepts", () => {
    render();

    for (const invalid of ["", "0", "-1", "2.5", "3651", "abc"]) type(ARCHIVE, invalid);
    for (const invalid of ["", "0", "-3", "1.5", "3651"]) type(DELETE, invalid);
    expect(state.updateSettings).not.toHaveBeenCalled();

    type(ARCHIVE, "7");
    expect(state.updateSettings).toHaveBeenLastCalledWith({ boardArchiveAfterDays: 7 });
    type(DELETE, "30");
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      boardDeleteArchivedAfterDays: 30,
    });
  });

  it("restores the persisted value when an invalid draft is abandoned", () => {
    state.settings = { boardArchiveAfterDays: 7 };
    render();

    type(ARCHIVE, "");
    expect(control(ARCHIVE)[0]!.props.value).toBe("");
    act(() => control(ARCHIVE)[0]!.props.onBlur());
    expect(control(ARCHIVE)[0]!.props.value).toBe("7");
  });

  it("offers a reset to the defaults only when something differs", () => {
    render();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    act(() => renderer!.unmount());
    state.settings = { boardArchiveAfterDays: 7, boardDeleteArchivedAfterDays: 30 };
    render();
    act(() => renderer!.root.findByType("button").props.onClick());
    expect(state.updateSettings).toHaveBeenCalledWith({
      boardArchiveAfterDays: 1,
      boardDeleteArchivedAfterDays: 14,
    });
  });
});

describe("deleted thread purge settings", () => {
  function renderPurge() {
    act(() => {
      renderer = create(<DeletedThreadPurgeSection />);
    });
  }

  it("defaults to 14 days before erasure", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.deletedThreadPurgeAfterDays).toBe(14);
    renderPurge();

    expect(control(PURGE)[0]!.props.value).toBe("14");
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  });

  it("says erasure is permanent and worktrees are never touched", () => {
    renderPurge();

    expect(text()).toContain("erasure is permanent");
    expect(text()).toContain("Worktrees on disk and provider-side histories are never touched");
  });

  it("shows the stored value and saves only values the schema accepts", () => {
    state.settings = { deletedThreadPurgeAfterDays: 30 };
    renderPurge();
    expect(control(PURGE)[0]!.props.value).toBe("30");

    act(() => renderer!.unmount());
    state.settings = {};
    renderPurge();

    for (const invalid of ["", "0", "-1", "2.5", "3651", "abc"]) type(PURGE, invalid);
    expect(state.updateSettings).not.toHaveBeenCalled();

    type(PURGE, "30");
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      deletedThreadPurgeAfterDays: 30,
    });
  });

  it("offers a reset to the default only when it differs", () => {
    renderPurge();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);

    act(() => renderer!.unmount());
    state.settings = { deletedThreadPurgeAfterDays: 30 };
    renderPurge();
    act(() => renderer!.root.findByType("button").props.onClick());
    expect(state.updateSettings).toHaveBeenCalledWith({
      deletedThreadPurgeAfterDays: 14,
    });
  });
});
