import { DEFAULT_POLICY_SETTINGS } from "@t3tools/ft3-policies/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => ({
  snapshot: null as unknown,
  read: null as unknown,
  pending: null as unknown,
  calls: [] as Array<{ label: string; input: unknown }>,
  commandResult: null as unknown,
}));

vi.mock("./state.ts", () => ({
  policiesEnvironment: {
    snapshot: (target: unknown) => ({ __query: "snapshot", target }),
    readDocument: (target: unknown) => ({ __query: "read", target }),
    pendingChange: (target: unknown) => ({ __query: "pending", target }),
    saveDocument: { label: "policies.saveDocument" },
    applyPending: { label: "policies.applyPending" },
    setApplyExternalEdits: { label: "policies.setApplyExternalEdits" },
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    const view = {
      error: null,
      isPending: false,
      dataUpdatedAt: 0,
      refresh: () => {},
    };
    if (atom === null) return { ...view, data: null };
    const query = (atom as { __query: string }).__query;
    const data =
      query === "snapshot" ? mocks.snapshot : query === "read" ? mocks.read : mocks.pending;
    return { ...view, data };
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => {
    return async (target: { input: unknown }) => {
      mocks.calls.push({ label: command.label, input: target.input });
      return mocks.commandResult;
    };
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "env-1",
}));

vi.mock("~/components/settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => ({ environment: { environmentId: "env-1" } }),
}));

vi.mock("~/components/settings/useScopedSettings", () => ({
  useScopedSettings: () => ({ ft3: { policies: DEFAULT_POLICY_SETTINGS } }),
}));

vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      <p>{description}</p>
      {control}
    </div>
  ),
  SettingsUnavailableGroup: ({
    children,
    message,
  }: {
    children: ReactNode;
    message?: ReactNode;
  }) => (message !== undefined ? <p>{message}</p> : <div>{children}</div>),
}));

import { PoliciesSettingsPanel } from "./PoliciesSettingsPanel.tsx";

const snapshotFixture = {
  configVersion: 1,
  warnings: [],
  documents: [
    {
      key: "routingPolicy",
      source: { kind: "builtin" },
      configured: true,
      applied: { revision: 1, sha256: "a".repeat(64), appliedAt: "2026-11-03T00:00:00Z" },
      seen: null,
      errors: [],
      warnings: [],
      kept: false,
      pending: false,
    },
    {
      key: "roles",
      source: { kind: "doc", address: { kind: "path", relPath: "roles/roles.json" } },
      configured: true,
      applied: { revision: 2, sha256: "b".repeat(64), appliedAt: "2026-11-03T00:00:00Z" },
      seen: null,
      errors: [],
      warnings: [],
      kept: false,
      pending: true,
    },
    {
      key: "leadSkills",
      source: { kind: "path", path: "/etc/ft3/lead-skills.json" },
      configured: true,
      applied: { revision: 3, sha256: "c".repeat(64), appliedAt: "2026-11-03T00:00:00Z" },
      seen: null,
      errors: [
        {
          code: "lead_skill_missing",
          severity: "error",
          message: 'Skill "review" is missing.',
          document: "leadSkills",
          line: 2,
        },
      ],
      warnings: [],
      kept: true,
      pending: false,
    },
  ],
};

const readFixture = {
  status: "ok",
  key: "routingPolicy",
  source: { kind: "builtin" },
  configured: true,
  files: [{ file: "routing-policy.md", content: "line1\nline2", sha256: "d".repeat(64) }],
  mainFile: "routing-policy.md",
};

function setup() {
  mocks.snapshot = snapshotFixture;
  mocks.read = readFixture;
  mocks.pending = {
    key: "roles",
    pending: true,
    change: {
      liveSha256: "e".repeat(64),
      valid: true,
      issues: [],
      files: [
        {
          file: "roles.json",
          appliedSha256: "b".repeat(64),
          liveSha256: "e".repeat(64),
          diff: "- old\n+ new",
        },
      ],
    },
  };
  mocks.calls = [];
  mocks.commandResult = null;
}

describe("policies settings panel", () => {
  it("lists the policy documents with their status badges", async () => {
    setup();
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Routing policy");
    expect(text).toContain("Built-in template");
    expect(text).toContain("Applied");
    expect(text).toContain("Pending external change");
    expect(text).toContain("Invalid: previous version kept");
    expect(text).toContain("File: /etc/ft3/lead-skills.json");
  });

  it("shows the pending diff and applies it in one click", async () => {
    setup();
    mocks.commandResult = {
      value: { status: "applied", snapshot: snapshotFixture },
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByText("Roles"));
    expect(screen.container.textContent).toContain("- old\n+ new");
    await userEvent.click(screen.getByText("Apply external change"));
    expect(mocks.calls).toEqual([
      {
        label: "policies.applyPending",
        input: { key: "roles", liveSha256: "e".repeat(64) },
      },
    ]);
    expect(screen.container.textContent).toContain("Applied. The external change is in effect.");
  });

  it("jumps to the error line when its number is clicked", async () => {
    setup();
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByText("Lead skills"));
    await userEvent.click(screen.getByText("L2"));
    const textarea = screen.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(textarea!.selectionStart).toBe(6);
  });

  it("says an invalid save is not applied and the previous version stays active", async () => {
    setup();
    mocks.commandResult = {
      value: { status: "invalid", snapshot: snapshotFixture },
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByText("Routing policy"));
    await userEvent.type(screen.getByLabelText("Edit routing-policy.md"), "!");
    await userEvent.click(screen.getByText("Save and apply"));
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]!.label).toBe("policies.saveDocument");
    const input = mocks.calls[0]!.input as { key: string; baseSha256: string; content: string };
    expect(input.key).toBe("routingPolicy");
    expect(input.baseSha256).toBe("d".repeat(64));
    expect(input.content).toContain("!");
    expect(screen.container.textContent).toContain(
      "Not applied: the document has errors, so the previous version stays active.",
    );
  });
});
