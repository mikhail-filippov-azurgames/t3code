import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  useRightPanelStore,
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
} from "~/rightPanelStore";
import { useClosedViewStore } from "~/closedViewStore";
import { reopenClosedView } from "~/reopenClosedView";
import {
  ft3Surface,
  ft3SurfaceActions,
  ft3SurfaceRegistry,
  ft3SurfaceTitle,
  normalizeFt3Surface,
} from "./panels.tsx";

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("coordinator") };

describe("FT3 panel registry", () => {
  it("offers Board in a server thread and declines a missing thread", () => {
    const open = vi.fn();
    const action = ft3SurfaceActions(ref, open).find((entry) => entry.label === "Board")!;
    expect(action.available).toBe(true);
    action.onClick();
    expect(open).toHaveBeenCalledWith(ref, { id: "ft3:board", kind: "ft3", surfaceType: "board" });
    open.mockClear();
    const disabled = ft3SurfaceActions(null, open).find((entry) => entry.label === "Board")!;
    expect(disabled.available).toBe(false);
    disabled.onClick();
    expect(open).not.toHaveBeenCalled();
    expect(ft3SurfaceRegistry.board?.component).toBeDefined();
    expect(ft3SurfaceTitle("board")).toBe("Board");
  });

  it("rejects unknown persisted types and inherited object names", () => {
    for (const surfaceType of ["missing", "constructor", "__proto__", "toString"]) {
      expect(normalizeFt3Surface(ft3Surface(surfaceType))).toEqual([]);
      expect(ft3SurfaceTitle(surfaceType)).toBe("Unavailable panel");
    }
    expect(normalizeFt3Surface({ ...ft3Surface("board"), id: "ft3:corrupt" })).toEqual([
      ft3Surface("board"),
    ]);
  });

  it("migrates a Board tab and drops unavailable types without losing native tabs", () => {
    const key = scopedThreadKey(ref);
    const state = migratePersistedRightPanelState({
      byThreadKey: {
        [key]: {
          isOpen: true,
          activeSurfaceId: "ft3:board",
          surfaces: [ft3Surface("board"), ft3Surface("removed"), { id: "diff", kind: "diff" }],
        },
      },
    });
    expect(state.byThreadKey[key]?.surfaces).toEqual([
      ft3Surface("board"),
      { id: "diff", kind: "diff" },
    ]);
    expect(state.byThreadKey[key]?.activeSurfaceId).toBe("ft3:board");
  });

  it("opens one tab per type, isolates environments and reopens a closed Board", async () => {
    useRightPanelStore.setState({ ...useRightPanelStore.getInitialState(), byThreadKey: {} });
    useClosedViewStore.setState({ entries: [] });
    const other = { ...ref, environmentId: EnvironmentId.make("other") };
    const panels = useRightPanelStore.getState();
    panels.openFt3Surface(ref, ft3Surface("board"));
    panels.openFt3Surface(ref, ft3Surface("board"));
    panels.openFt3Surface(other, ft3Surface("board"));
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
    ).toHaveLength(1);
    panels.closeSurface(ref, "ft3:board");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, other).isOpen,
    ).toBe(true);
    const view = useClosedViewStore.getState().entries[0]!;
    expect(await reopenClosedView(view, { workspaceAvailable: false, openPreview: vi.fn() })).toBe(
      true,
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("ft3:board");
  });
});
