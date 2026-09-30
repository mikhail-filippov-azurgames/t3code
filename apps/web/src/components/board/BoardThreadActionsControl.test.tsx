import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardThreadActionsControl } from "./BoardThreadActionsControl";
import { resolveBoardThreadActionsControlModel } from "./boardThreadActions.logic";

const ENVIRONMENT = "environment-primary";

function markupFor(overrides: {
  readonly isCoordinator?: boolean;
  readonly hasDelegationParent?: boolean;
  readonly isServerThread?: boolean;
}) {
  const model = resolveBoardThreadActionsControlModel({
    isServerThread: overrides.isServerThread ?? true,
    environmentId: ENVIRONMENT,
    primaryEnvironmentId: ENVIRONMENT,
    isCoordinator: overrides.isCoordinator ?? false,
    hasDelegationParent: overrides.hasDelegationParent ?? false,
  });
  return renderToStaticMarkup(
    createElement(BoardThreadActionsControl, { model, onSelect: () => {} }),
  );
}

describe("BoardThreadActionsControl", () => {
  it("renders the toolbar control for an eligible root thread", () => {
    const markup = markupFor({});

    expect(markup).toContain('data-toolbar-control=""');
    expect(markup).toContain('aria-label="Coordinator actions"');
  });

  it("renders nothing for a delegated child", () => {
    expect(markupFor({ hasDelegationParent: true })).toBe("");
  });

  it("renders nothing for a draft thread", () => {
    expect(markupFor({ isServerThread: false })).toBe("");
  });
});
