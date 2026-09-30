import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BoardThreadAction,
  buildBoardThreadContextMenuItems,
  isBoardThreadActionId,
  resolveBoardThreadActionsControlModel,
  resolveBoardThreadMenuInput,
  runBoardThreadAction,
  type BoardThreadActionPorts,
  type BoardThreadMenuInput,
} from "./boardThreadActions.logic";

const ENVIRONMENT = EnvironmentId.make("environment-primary");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-other");
const THREAD = ThreadId.make("thread-coordinator");

const success = () => AsyncResult.success(undefined);
const failure = (message = "boom") => AsyncResult.failure(Cause.fail(new Error(message)));
const interrupted = () => AsyncResult.failure(Cause.interrupt());

function makePorts(overrides: Partial<BoardThreadActionPorts> = {}): BoardThreadActionPorts {
  return {
    addCoordinator: vi.fn(async () => success()),
    removeCoordinator: vi.fn(async () => success()),
    resendCoordinatorBrief: vi.fn(async () => success()),
    openCreateTask: vi.fn(),
    confirmRemoveCoordinator: vi.fn(async () => true),
    notify: vi.fn(),
    ...overrides,
  };
}

function run(
  actionId: Parameters<typeof runBoardThreadAction>[0]["actionId"],
  ports: BoardThreadActionPorts,
  primaryEnvironmentId: EnvironmentId | null = ENVIRONMENT,
) {
  return runBoardThreadAction({ actionId, threadId: THREAD, primaryEnvironmentId, ports });
}

describe("board thread action ids", () => {
  it("accepts every declared id and rejects unknown menu ids", () => {
    for (const id of Object.values(BoardThreadAction)) {
      expect(isBoardThreadActionId(id)).toBe(true);
    }
    expect(isBoardThreadActionId("archive")).toBe(false);
    expect(isBoardThreadActionId(null)).toBe(false);
    expect(isBoardThreadActionId(undefined)).toBe(false);
  });
});

describe("resolveBoardThreadMenuInput", () => {
  const base: BoardThreadMenuInput = {
    isServerThread: true,
    environmentId: ENVIRONMENT,
    primaryEnvironmentId: ENVIRONMENT,
    isCoordinator: false,
    hasDelegationParent: false,
  };

  it("is eligible only for a server thread on the primary environment", () => {
    expect(resolveBoardThreadMenuInput(base).isBoardEligible).toBe(true);
    expect(resolveBoardThreadMenuInput({ ...base, isServerThread: false }).isBoardEligible).toBe(
      false,
    );
    expect(
      resolveBoardThreadMenuInput({ ...base, environmentId: OTHER_ENVIRONMENT }).isBoardEligible,
    ).toBe(false);
    expect(
      resolveBoardThreadMenuInput({ ...base, primaryEnvironmentId: null }).isBoardEligible,
    ).toBe(false);
  });
});

describe("buildBoardThreadContextMenuItems", () => {
  it("offers Make Coordinator to a root thread that is not a Coordinator", () => {
    expect(
      buildBoardThreadContextMenuItems({
        isBoardEligible: true,
        isCoordinator: false,
        hasDelegationParent: false,
      }),
    ).toEqual({
      topItems: [{ id: "board-make-orchestrator", label: "Make Coordinator" }],
      destructiveItems: [],
    });
  });

  it("offers the Coordinator actions and a destructive removal", () => {
    expect(
      buildBoardThreadContextMenuItems({
        isBoardEligible: true,
        isCoordinator: true,
        hasDelegationParent: false,
      }),
    ).toEqual({
      topItems: [
        { id: "board-create-task", label: "Create task" },
        { id: "board-resend-brief", label: "Resend Coordinator brief" },
      ],
      destructiveItems: [
        { id: "board-unmark-orchestrator", label: "Remove Coordinator", destructive: true },
      ],
    });
  });

  it("hides board actions for delegated children and other environments", () => {
    expect(
      buildBoardThreadContextMenuItems({
        isBoardEligible: true,
        isCoordinator: false,
        hasDelegationParent: true,
      }),
    ).toEqual({ topItems: [], destructiveItems: [] });
    expect(
      buildBoardThreadContextMenuItems({
        isBoardEligible: false,
        isCoordinator: true,
        hasDelegationParent: false,
      }),
    ).toEqual({ topItems: [], destructiveItems: [] });
  });
});

describe("resolveBoardThreadActionsControlModel", () => {
  const shape = (overrides: Partial<BoardThreadMenuInput>): BoardThreadMenuInput => ({
    isServerThread: true,
    environmentId: ENVIRONMENT,
    primaryEnvironmentId: ENVIRONMENT,
    isCoordinator: false,
    hasDelegationParent: false,
    ...overrides,
  });

  it("renders a menu for a root thread", () => {
    expect(resolveBoardThreadActionsControlModel(shape({}))).toEqual({
      kind: "menu",
      topItems: [{ id: "board-make-orchestrator", label: "Make Coordinator" }],
      destructiveItems: [],
    });
  });

  it("is hidden for delegated children and ineligible threads", () => {
    expect(resolveBoardThreadActionsControlModel(shape({ hasDelegationParent: true }))).toEqual({
      kind: "hidden",
      topItems: [],
      destructiveItems: [],
    });
    expect(resolveBoardThreadActionsControlModel(shape({ isServerThread: false }))).toEqual({
      kind: "hidden",
      topItems: [],
      destructiveItems: [],
    });
  });
});

describe("toolbar and sidebar item-set parity", () => {
  const shapes: ReadonlyArray<BoardThreadMenuInput> = [
    {
      isServerThread: true,
      environmentId: ENVIRONMENT,
      primaryEnvironmentId: ENVIRONMENT,
      isCoordinator: false,
      hasDelegationParent: false,
    },
    {
      isServerThread: true,
      environmentId: ENVIRONMENT,
      primaryEnvironmentId: ENVIRONMENT,
      isCoordinator: true,
      hasDelegationParent: false,
    },
    {
      isServerThread: true,
      environmentId: ENVIRONMENT,
      primaryEnvironmentId: ENVIRONMENT,
      isCoordinator: false,
      hasDelegationParent: true,
    },
    {
      isServerThread: false,
      environmentId: ENVIRONMENT,
      primaryEnvironmentId: ENVIRONMENT,
      isCoordinator: false,
      hasDelegationParent: false,
    },
    {
      isServerThread: true,
      environmentId: OTHER_ENVIRONMENT,
      primaryEnvironmentId: ENVIRONMENT,
      isCoordinator: true,
      hasDelegationParent: false,
    },
  ];

  it("produces the same item set for the same thread shape", () => {
    for (const shape of shapes) {
      const sidebar = buildBoardThreadContextMenuItems(resolveBoardThreadMenuInput(shape));
      const toolbar = resolveBoardThreadActionsControlModel(shape);
      const toolbarItems =
        toolbar.kind === "hidden" ? { topItems: [], destructiveItems: [] } : toolbar;
      expect(toolbarItems.topItems).toEqual([...sidebar.topItems]);
      expect(toolbarItems.destructiveItems).toEqual([...sidebar.destructiveItems]);
    }
  });
});

describe("runBoardThreadAction", () => {
  it("marks the Coordinator and reports failures with the sidebar's toast copy", async () => {
    const added = makePorts();
    await run(BoardThreadAction.makeCoordinator, added);
    expect(added.addCoordinator).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT,
      input: { threadId: THREAD },
    });
    expect(added.notify).not.toHaveBeenCalled();

    const failing = makePorts({ addCoordinator: vi.fn(async () => failure("nope")) });
    await run(BoardThreadAction.makeCoordinator, failing);
    expect(failing.notify).toHaveBeenCalledWith({
      type: "error",
      title: "Could not mark the Coordinator",
      description: "nope",
    });

    const cancelled = makePorts({ addCoordinator: vi.fn(async () => interrupted()) });
    await run(BoardThreadAction.makeCoordinator, cancelled);
    expect(cancelled.notify).not.toHaveBeenCalled();
  });

  it("does nothing without a primary environment", async () => {
    const ports = makePorts();
    await run(BoardThreadAction.makeCoordinator, ports, null);
    await run(BoardThreadAction.resendBrief, ports, null);
    await run(BoardThreadAction.removeCoordinator, ports, null);
    expect(ports.addCoordinator).not.toHaveBeenCalled();
    expect(ports.resendCoordinatorBrief).not.toHaveBeenCalled();
    expect(ports.removeCoordinator).not.toHaveBeenCalled();
    expect(ports.notify).not.toHaveBeenCalled();
  });

  it("opens the board task dialog without a mutation", async () => {
    const ports = makePorts();
    await run(BoardThreadAction.createTask, ports);
    expect(ports.openCreateTask).toHaveBeenCalledWith(THREAD);
    expect(ports.addCoordinator).not.toHaveBeenCalled();
    expect(ports.notify).not.toHaveBeenCalled();
  });

  it("resends the brief with success and failure toasts", async () => {
    const successPorts = makePorts();
    await run(BoardThreadAction.resendBrief, successPorts);
    expect(successPorts.notify).toHaveBeenCalledWith({
      type: "success",
      title: "Coordinator brief resent",
      description: "The Coordinator will see it in its thread.",
    });

    const failing = makePorts({ resendCoordinatorBrief: vi.fn(async () => failure("offline")) });
    await run(BoardThreadAction.resendBrief, failing);
    expect(failing.notify).toHaveBeenCalledWith({
      type: "error",
      title: "Could not resend the Coordinator brief",
      description: "offline",
    });
  });

  it("confirms before removing and aborts when declined", async () => {
    const declined = makePorts({ confirmRemoveCoordinator: vi.fn(async () => false) });
    await run(BoardThreadAction.removeCoordinator, declined);
    expect(declined.confirmRemoveCoordinator).toHaveBeenCalledTimes(1);
    expect(declined.removeCoordinator).not.toHaveBeenCalled();
    expect(declined.notify).not.toHaveBeenCalled();

    const confirmed = makePorts();
    await run(BoardThreadAction.removeCoordinator, confirmed);
    expect(confirmed.removeCoordinator).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT,
      input: { threadId: THREAD },
    });
    expect(confirmed.notify).not.toHaveBeenCalled();

    const failing = makePorts({ removeCoordinator: vi.fn(async () => failure("locked")) });
    await run(BoardThreadAction.removeCoordinator, failing);
    expect(failing.notify).toHaveBeenCalledWith({
      type: "error",
      title: "Could not remove the Coordinator",
      description: "locked",
    });
  });
});
