import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications-and-sound",
  inApp: true,
  focused: true,
  turnState: "running" as string,
  completedAt: null as string | null,
  delegationParent: null as null | {
    parentThreadId: string;
    parentEnvironmentId: string;
    role: string;
  },
  threads: null as null | Array<Record<string, unknown>>,
  toast: vi.fn(() => "toast-1"),
  navigate: vi.fn(),
  sound: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: "live",
    snapshot: Option.some({
      threads: state.threads ?? [
        {
          id: "thread-1",
          title: "Fix the login form",
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          session: null,
          latestTurn: {
            turnId: "turn-1",
            state: state.turnState,
            completedAt: state.completedAt,
          },
          delegationParent: state.delegationParent,
        },
      ],
    }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({ environmentId: "env-1", threadId: "other-thread" }),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: { notificationMode: string; inAppNotificationsEnabled: boolean }) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env-1" }] }),
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: vi.fn() } }));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast, close: vi.fn() } }));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
import { selectUnreadNoticeCount, useNotificationsStore } from "../state/notifications";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = "notifications-and-sound";
  state.inApp = true;
  state.focused = true;
  state.turnState = "running";
  state.completedAt = null;
  state.delegationParent = null;
  state.threads = null;
  useNotificationsStore.setState({ notices: [], lastReadAt: null });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "Notification",
    Object.assign(
      vi.fn(function (_title: string, options: NotificationOptions) {
        return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
      }),
      { permission: "granted" },
    ),
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("records a thread-completed notice at the toast point", async () => {
  await render();
  state.turnState = "completed";
  state.completedAt = new Date(Date.now() - 60_000).toISOString();
  await render();

  const notices = useNotificationsStore.getState().notices;
  expect(notices).toHaveLength(1);
  expect(notices[0]?.kind).toBe("thread-completed");
  expect(notices[0]?.title).toBe("Thread completed");
  expect(notices[0]?.body).toBe("Fix the login form");
  expect(notices[0]?.key).toBe("env-1:thread-1:completed:turn-1");
});

it("records an error notice for a failed thread", async () => {
  await render();
  state.turnState = "error";
  await render();
  await render();

  const notices = useNotificationsStore.getState().notices;
  expect(notices.map((notice) => notice.kind)).toEqual(["error"]);
  expect(notices[0]?.title).toBe("Thread failed");
});

it("does not record a notice for a thread that is only running", async () => {
  await render();
  await render();
  expect(useNotificationsStore.getState().notices).toHaveLength(0);
});

it("keeps collecting notices while all alerts are off", async () => {
  state.mode = "off";
  state.inApp = false;
  await render();
  state.turnState = "completed";
  state.completedAt = new Date(Date.now() - 60_000).toISOString();
  await render();

  const notices = useNotificationsStore.getState().notices;
  expect(notices).toHaveLength(1);
  expect(notices[0]?.key).toBe("env-1:thread-1:completed:turn-1");
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.sound).not.toHaveBeenCalled();
});

function child(id: string, title: string, completedAt: string | null) {
  return {
    id,
    title,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: {
      turnId: `turn-${id}`,
      state: completedAt === null ? "running" : "completed",
      completedAt,
    },
    delegationParent: {
      parentThreadId: "parent-1",
      parentEnvironmentId: "env-1",
      role: "implementation",
    },
  };
}

it("collapses three delegated child completions into one summary row with the latest name", async () => {
  state.threads = [
    child("child-1", "Child one", null),
    child("child-2", "Child two", null),
    child("child-3", "Child three", null),
  ];
  await render();
  state.threads = [
    child("child-1", "Child one", new Date(Date.now() - 3_000).toISOString()),
    child("child-2", "Child two", new Date(Date.now() - 2_000).toISOString()),
    child("child-3", "Child three", new Date(Date.now() - 1_000).toISOString()),
  ];
  await render();

  const notices = useNotificationsStore.getState().notices;
  expect(notices).toHaveLength(1);
  expect(notices[0]?.count).toBe(3);
  expect(notices[0]?.title).toBe("3 delegated results");
  expect(notices[0]?.body).toBe("Child three");
  expect(notices[0]?.key).toBe("thread-completed-group:env-1:parent-1");
  expect(selectUnreadNoticeCount(useNotificationsStore.getState())).toBe(1);
});

it("keeps a delegated child failure as its own row beside the completion group", async () => {
  state.threads = [
    child("child-1", "Child one", null),
    child("child-2", "Child two", null),
    child("child-3", "Child three", null),
    child("child-4", "Child four", null),
  ];
  await render();
  state.threads = [
    child("child-1", "Child one", new Date(Date.now() - 3_000).toISOString()),
    child("child-2", "Child two", new Date(Date.now() - 2_000).toISOString()),
    child("child-3", "Child three", new Date(Date.now() - 1_000).toISOString()),
    {
      ...child("child-4", "Child four", null),
      latestTurn: { turnId: "turn-child-4", state: "error", completedAt: null },
    },
  ];
  await render();

  const notices = useNotificationsStore.getState().notices;
  expect(notices).toHaveLength(2);
  expect(notices.find((entry) => entry.count !== undefined)?.count).toBe(3);
  expect(notices.some((entry) => entry.kind === "error" && entry.title === "Thread failed")).toBe(
    true,
  );
  expect(selectUnreadNoticeCount(useNotificationsStore.getState())).toBe(2);
});
