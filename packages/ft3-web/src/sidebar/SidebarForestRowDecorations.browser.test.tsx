import { TooltipProvider } from "~/components/ui/tooltip";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../../apps/web/test/render";
import {
  SidebarDelegationMarker,
  SidebarForestRowDecorations,
  SidebarRoleBadgeMarker,
  type SidebarForestRowModel,
} from "./SidebarForestRowDecorations.tsx";

const model: SidebarForestRowModel = {
  key: "thread:row",
  depth: 0,
  descendantCount: 0,
  collapsed: false,
  toggleKey: null,
  workingCount: 1,
  returnedCount: 0,
  statusOverride: null,
  roleBadge: { kind: "role", role: "implementation", label: "Implementation" },
  isDelegatedChild: true,
};

describe("sidebar row decorations", () => {
  it("leaves the board role glyph to the row meta line", async () => {
    await using screen = await render(
      <TooltipProvider>
        <SidebarForestRowDecorations model={model} onToggleCollapse={() => {}} />
      </TooltipProvider>,
    );

    expect(screen.container.querySelector('[aria-label="Implementation"]')).toBeNull();
    expect(
      screen.getByTestId("sidebar-delegated-children-working-thread:row").element(),
    ).toBeTruthy();
  });

  it("renders the role glyph and the coordinator mark", async () => {
    await using screen = await render(
      <TooltipProvider>
        <SidebarRoleBadgeMarker model={model} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("Implementation")).toBeTruthy();

    await screen.rerender(
      <TooltipProvider>
        <SidebarRoleBadgeMarker
          model={{
            ...model,
            roleBadge: { kind: "orchestrator", label: "Coordinator" },
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("Coordinator")).toBeTruthy();
  });

  it("renders a generic child arrow in the top-right time slot", async () => {
    await using screen = await render(
      <TooltipProvider>
        <SidebarDelegationMarker model={model} />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("Implementation delegated subtask")).toBeTruthy();
    expect(screen.getByTestId("sidebar-delegated-child-marker-thread:row").element()).toBeTruthy();
  });
});
