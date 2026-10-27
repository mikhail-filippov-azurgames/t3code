import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {
    confirmThreadDelete: true,
    confirmThreadArchive: true,
    archiveThreadChildren: "always-yes",
  },
  confirmMessages: [] as string[],
  threads: [] as Array<{
    id: string;
    environmentId: string;
    archivedAt: string | null;
    createdAt: string;
    runtime: { status: string; activeRunId: string | null };
    lineage: { parentThreadId: string };
  }>,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof state.settings) => unknown) =>
    select(state.settings),
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  readThreadShells: () => state.threads,
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({
    dialogs: {
      confirm: async (message: string) => {
        state.confirmMessages.push(message);
        return true;
      },
    },
  }),
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => {} },
}));
vi.mock("./useSwitchThreadProvider", () => ({
  useSwitchThreadProvider: () => ({ attemptSwitchProvider: vi.fn() }),
}));
vi.mock("./switchProviderStore", () => ({
  requestSwitchProviderTarget: vi.fn(),
}));
vi.mock("./threadChildrenDialog", () => ({
  requestThreadChildrenDialog: vi.fn(async () => "no"),
}));

import { useDelegationThreadActions } from "./useDelegationThreadActions";

const parentRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("parent"));
const parent = {
  id: ThreadId.make("parent"),
  environmentId: EnvironmentId.make("env"),
  projectId: "project",
  title: "Parent",
} as unknown as EnvironmentThreadShell;
const child = {
  id: "child",
  environmentId: "env",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  runtime: { status: "idle", activeRunId: null },
  lineage: { parentThreadId: "parent" },
};

function createActions() {
  const archiveThread = vi.fn(async () => ({ _tag: "Success" as const }));
  const deleteThread = vi.fn(async () => ({ _tag: "Success" as const }));
  return {
    archiveThread,
    deleteThread,
    run: useDelegationThreadActions({
      archiveThread,
      deleteThread,
    } as unknown as Parameters<typeof useDelegationThreadActions>[0]),
  };
}

beforeEach(() => {
  state.settings.archiveThreadChildren = "always-yes";
  state.confirmMessages = [];
  state.threads = [];
});

describe("useDelegationThreadActions archive/delete interception", () => {
  it("leaves archive to upstream when the thread has no delegated children", async () => {
    const actions = createActions();
    await expect(actions.run("archive", parent, parentRef)).resolves.toBe(false);
    expect(actions.archiveThread).not.toHaveBeenCalled();
    expect(state.confirmMessages).toEqual([]);
  });

  it("archives children before the parent when the thread has delegated children", async () => {
    state.threads = [child];
    const actions = createActions();
    await expect(actions.run("archive", parent, parentRef)).resolves.toBe(true);
    expect(actions.archiveThread).toHaveBeenCalledTimes(2);
    expect(state.confirmMessages).toEqual([]);
  });

  it("leaves delete to upstream when the thread has no delegated descendants", async () => {
    const actions = createActions();
    await expect(actions.run("delete", parent, parentRef)).resolves.toBe(false);
    expect(actions.deleteThread).not.toHaveBeenCalled();
    expect(state.confirmMessages).toEqual([]);
  });

  it("confirms the server-side cascade when the thread has delegated descendants", async () => {
    state.threads = [child];
    const actions = createActions();
    await expect(actions.run("delete", parent, parentRef)).resolves.toBe(true);
    expect(actions.deleteThread).toHaveBeenCalledWith(parentRef);
    expect(state.confirmMessages).toEqual([
      'Delete thread "Parent"?\nThis permanently clears conversation history for this thread.\n1 delegated subtask under it will also be deleted.',
    ]);
  });
});
