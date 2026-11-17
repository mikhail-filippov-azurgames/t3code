import { DEFAULT_POLICY_SETTINGS } from "@t3tools/ft3-policies/settings";
import { FEATURE_IDS } from "@t3tools/ft3-policies/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";

const mocks = vi.hoisted(() => ({
  snapshot: null as unknown,
  read: null as unknown,
  pending: null as unknown,
  storeDocuments: null as unknown,
  readError: null as string | null,
  pendingError: null as string | null,
  policySettings: null as unknown,
  projectSettingsOverrides: {} as Record<string, unknown>,
  projects: [] as Array<{ id: string; title: string; environmentId: string }>,
  projectSnapshots: {} as Record<string, unknown>,
  snapshotInputs: [] as Array<{ projectId?: string }>,
  liveRefreshKeys: [] as string[],
  calls: [] as Array<{ label: string; input: unknown }>,
  refreshes: [] as string[],
  queries: [] as unknown[],
  commandResult: null as unknown,
}));

vi.mock("./state.ts", () => ({
  policiesEnvironment: {
    snapshot: (target: unknown) => ({ __query: "snapshot", target }),
    readDocument: (target: unknown) => ({ __query: "read", target }),
    pendingChange: (target: unknown) => ({ __query: "pending", target }),
    listStoreDocuments: (target: unknown) => ({ __query: "store-documents", target }),
    saveDocument: { label: "policies.saveDocument" },
    applyPending: { label: "policies.applyPending" },
    setApplyExternalEdits: { label: "policies.setApplyExternalEdits" },
    setDocument: { label: "policies.setDocument" },
    setFeature: { label: "policies.setFeature" },
    browseServerDirectory: { label: "policies.browseServerDirectory" },
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    const view = {
      error: null as string | null,
      isPending: false,
      dataUpdatedAt: 0,
    };
    if (atom === null) return { ...view, data: null, refresh: () => {} };
    const query = (atom as { __query: string }).__query;
    const input = (atom as { target: { input: { projectId?: string } } }).target.input;
    if (query === "snapshot") mocks.snapshotInputs.push(input);
    if (query === "store-documents") {
      mocks.queries.push(input);
    }
    const data =
      query === "snapshot"
        ? input.projectId === undefined
          ? mocks.snapshot
          : (mocks.projectSnapshots[input.projectId] ?? mocks.snapshot)
        : query === "read"
          ? mocks.read
          : query === "pending"
            ? mocks.pending
            : mocks.storeDocuments;
    const error =
      query === "read" ? mocks.readError : query === "pending" ? mocks.pendingError : null;
    return {
      ...view,
      data,
      error,
      refresh: () => {
        mocks.refreshes.push(query);
      },
    };
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

vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useProjects: () => mocks.projects,
}));

vi.mock("~/hooks/useLiveRefresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/hooks/useLiveRefresh")>();
  return {
    ...actual,
    useLiveRefresh: (refresh: (() => void) | null, options: { key?: string }) => {
      if (options.key !== undefined) mocks.liveRefreshKeys.push(options.key);
      return actual.useLiveRefresh(refresh, options);
    },
  };
});

vi.mock("~/components/settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => ({ environment: { environmentId: "env-1" } }),
}));

vi.mock("~/components/settings/useScopedSettings", () => ({
  useScopedSettings: () => ({
    ft3: { policies: mocks.policySettings },
    projectSettingsOverrides: mocks.projectSettingsOverrides,
  }),
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

const featureStatesOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries(
    FEATURE_IDS.map((id) => [
      id,
      {
        id,
        requestedEnabled: false,
        effectiveEnabled: false,
        offReason: null,
        ...(overrides[id] as object | undefined),
      },
    ]),
  );

const snapshotFixture = {
  configVersion: 1,
  warnings: [],
  needsAttention: false,
  features: featureStatesOf(),
  featureSources: Object.fromEntries(FEATURE_IDS.map((id) => [id, "default"])),
  requirements: {},
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
  key: "leadSkills",
  source: { kind: "doc", address: { kind: "path", relPath: "lead-skills/lead-skills.json" } },
  configured: true,
  files: [{ file: "", content: "line1\nline2", sha256: "d".repeat(64) }],
  mainFile: "",
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
  mocks.refreshes = [];
  mocks.queries = [];
  mocks.projects = [];
  mocks.projectSettingsOverrides = {};
  mocks.projectSnapshots = {};
  mocks.snapshotInputs = [];
  mocks.liveRefreshKeys = [];
  mocks.commandResult = null;
  mocks.readError = null;
  mocks.pendingError = null;
  mocks.policySettings = DEFAULT_POLICY_SETTINGS;
  mocks.storeDocuments = {
    documents: [
      {
        stableId: "id-roles",
        relPath: "roles/roles.json",
        name: "roles.json",
        description: "Role map",
      },
      {
        stableId: "id-routing",
        relPath: "policies/routing-policy.md",
        name: "routing-policy.md",
        description: "",
      },
    ],
  };
}

describe("policies settings panel", () => {
  it("explains planning overrides that invalidate environment documents", async () => {
    setup();
    mocks.projects = [
      { id: "alpha", title: "Alpha", environmentId: "env-1" },
      { id: "other", title: "Other environment", environmentId: "env-2" },
    ];
    mocks.projectSettingsOverrides = {
      alpha: { ft3FeatureToggles: { planning: true } },
      other: { ft3FeatureToggles: { planning: true } },
    };
    mocks.snapshot = {
      ...snapshotFixture,
      documents: snapshotFixture.documents.map((document) => ({
        ...document,
        pending: false,
        kept: true,
        errors: [
          document.key === "leadSkills"
            ? {
                code: "lead_skill_missing",
                severity: "error",
                document: document.key,
                subject: "plan-orchestrator",
                message: 'Lead skill "plan-orchestrator" is missing.',
              }
            : {
                code: "role_missing",
                severity: "error",
                document: document.key,
                subject: "planner",
                message: 'Role "planner" is required by planning.',
              },
        ],
      })),
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    const hint = screen.container.querySelector('[role="note"]')?.textContent;
    expect(hint).toContain("project override for “Alpha”");
    expect(hint).toContain("planner routing row");
    expect(hint).toContain("planner role and its Markdown file");
    expect(hint).toContain("plan-orchestrator lead skill");
    expect(hint).not.toContain("Other environment");
    if (import.meta.env.VITE_POLICY_HINT_EVIDENCE === "1") {
      const wasDark = document.documentElement.classList.contains("dark");
      try {
        for (const theme of ["light", "dark"]) {
          document.documentElement.classList.toggle("dark", theme === "dark");
          await page.screenshot({ path: `../../../../.t3/evidence/policy-hint-${theme}.png` });
        }
      } finally {
        document.documentElement.classList.toggle("dark", wasDark);
      }
    }
  });

  it("lists the policy documents with their status badges", async () => {
    setup();
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Routing policy");
    expect(text).toContain("Built-in template");
    expect(text).toContain("Applied");
    expect(text).toContain("Applied · change pending");
    expect(text).toContain("Invalid: previous version kept");
    expect(text).toContain("File: /etc/ft3/lead-skills.json");
  });

  it("shows the pending diff and applies it in one click", async () => {
    setup();
    mocks.commandResult = {
      value: { status: "applied", snapshot: snapshotFixture },
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Roles" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.click(screen.getByRole("button", { name: "Go to line 2" }));
    const textarea = screen.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(textarea!.selectionStart).toBe(6);
  });

  it("switches to the issue's file before jumping to its line", async () => {
    setup();
    mocks.snapshot = {
      ...snapshotFixture,
      documents: snapshotFixture.documents.map((document) =>
        document.key === "leadSkills"
          ? {
              ...document,
              errors: [
                {
                  code: "lead_skill_missing",
                  severity: "error",
                  message: 'Skill "review" is missing.',
                  document: "leadSkills",
                  line: 2,
                  file: "board-orchestrator/SKILL.md",
                },
              ],
            }
          : document,
      ),
    };
    mocks.read = {
      status: "ok",
      key: "leadSkills",
      source: { kind: "path", path: "/etc/ft3/lead-skills.json" },
      configured: true,
      files: [
        { file: "", content: "main file\nsecond line", sha256: "d".repeat(64) },
        {
          file: "board-orchestrator/SKILL.md",
          content: "skill line one\nskill line two",
          sha256: "e".repeat(64),
        },
      ],
      mainFile: "",
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    const tabs = screen.container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Go to line 2" }));
    const textarea = screen.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe("skill line one\nskill line two");
    expect(document.activeElement).toBe(textarea);
    expect(textarea!.selectionStart).toBe(15);
  });

  it("says an invalid save is not applied and the previous version stays active", async () => {
    setup();
    mocks.commandResult = {
      value: { status: "invalid", snapshot: snapshotFixture },
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.type(screen.getByLabelText("Edit lead-skills.json"), "!");
    await userEvent.click(screen.getByText("Save and apply"));
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]!.label).toBe("policies.saveDocument");
    const input = mocks.calls[0]!.input as {
      key: string;
      file: string;
      baseSha256: string;
      content: string;
    };
    expect(input.key).toBe("leadSkills");
    expect(input.file).toBe("");
    expect(input.baseSha256).toBe("d".repeat(64));
    expect(input.content).toContain("!");
    expect(screen.container.textContent).toContain(
      "Not applied: the document has errors, so the previous version stays active.",
    );
  });

  it("shows why the pending change could not be loaded", async () => {
    setup();
    mocks.pendingError = "Forbidden: orchestration:read required";
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Roles" }));
    expect(screen.container.textContent).toContain(
      "Could not load the pending change: Forbidden: orchestration:read required",
    );
  });

  it("opens a built-in template read-only with a View button", async () => {
    setup();
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "View Routing policy" }));
    await expect
      .element(screen.getByLabelText("View routing-policy.md"))
      .toHaveAttribute("readonly");
    expect(screen.container.textContent).toContain("Built-in template: read-only.");
    expect(screen.container.textContent).not.toContain("Save and apply");
  });

  it("explains a built-in template that is not applied yet", async () => {
    setup();
    mocks.snapshot = {
      ...snapshotFixture,
      documents: snapshotFixture.documents.map((document) =>
        document.key === "routingPolicy" ? { ...document, applied: null } : document,
      ),
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "View Routing policy" }));
    expect(screen.container.textContent).toContain(
      "Not applied yet: the built-in template has no valid version",
    );
    expect(screen.container.querySelector('[title^="Not applied yet"]')).not.toBeNull();
  });

  it("shows why a document could not be loaded", async () => {
    setup();
    mocks.readError = "Forbidden: settings:write required";
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Roles" }));
    expect(screen.container.textContent).toContain(
      "Could not load this document: Forbidden: settings:write required",
    );
  });

  it("saves a feature toggle through the policies API", async () => {
    setup();
    mocks.commandResult = { value: { snapshot: snapshotFixture } };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    const toggle = screen.container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Enable board"]',
    );
    expect(toggle).not.toBeNull();
    toggle!.click();
    await vi.waitFor(() => {
      expect(mocks.calls.filter((entry) => entry.label === "policies.setFeature")).toHaveLength(1);
    });
    expect(mocks.calls.find((entry) => entry.label === "policies.setFeature")).toEqual({
      label: "policies.setFeature",
      input: { feature: "board", enabled: !DEFAULT_POLICY_SETTINGS.features.board },
    });
    // The mocked settings do not change, so the switch returns to its stored state.
    await expect
      .element(toggle!)
      .toHaveAttribute("aria-checked", String(DEFAULT_POLICY_SETTINGS.features.board));

    toggle!.click();
    await vi.waitFor(() => {
      expect(mocks.calls.filter((entry) => entry.label === "policies.setFeature")).toHaveLength(2);
    });
  });

  it("selects a project snapshot and keys live refresh by that project", async () => {
    setup();
    mocks.projects = [{ id: "project-alpha", title: "Alpha", environmentId: "env-1" }];
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    const picker = screen.getByRole("combobox", { name: "Feature toggles project" });
    expect(screen.container.textContent).toContain("All projects (default)");

    await userEvent.click(picker);
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));

    expect(screen.container.textContent).toContain("Alpha");
    expect(mocks.snapshotInputs).toContainEqual({ projectId: "project-alpha" });
    expect(mocks.liveRefreshKeys.at(-1)).toBe("ft3-policies:env-1:project-alpha");
  });

  it("shows inherited and environment-only feature values from the selected snapshot", async () => {
    setup();
    mocks.projects = [{ id: "project-alpha", title: "Alpha", environmentId: "env-1" }];
    mocks.snapshot = {
      ...snapshotFixture,
      features: featureStatesOf({
        documents: { requestedEnabled: true, effectiveEnabled: true },
      }),
    };
    mocks.projectSnapshots["project-alpha"] = {
      ...snapshotFixture,
      features: featureStatesOf({
        board: {
          requestedEnabled: true,
          effectiveEnabled: false,
          offReason: { code: "feature_dependency_off", dependency: "documents" },
        },
        documents: { requestedEnabled: false, effectiveEnabled: false },
      }),
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("combobox", { name: "Feature toggles project" }));
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));

    expect(screen.container.textContent).toContain("Inherited: on");
    expect(screen.container.textContent).toContain("Effective: off");
    expect(screen.container.textContent).toContain("Environment value: on");
    expect(screen.container.textContent).toContain(
      "Off: it needs the documents feature, which is off.",
    );
    expect(screen.container.textContent).toContain("On");
    expect(
      screen.container.querySelector('[role="switch"][aria-label="Enable documents"]'),
    ).toBeNull();
  });

  it("limits project switches to guarded features and their dependencies", async () => {
    setup();
    mocks.projects = [{ id: "project-alpha", title: "Alpha", environmentId: "env-1" }];
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("combobox", { name: "Feature toggles project" }));
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));

    for (const feature of ["board", "mail", "planning", "roles", "delegation"]) {
      expect(
        screen.container.querySelector(`[role="switch"][aria-label="Enable ${feature}"]`),
      ).not.toBeNull();
    }
    for (const feature of ["documents", "orchestration", "files"]) {
      expect(
        screen.container.querySelector(`[role="switch"][aria-label="Enable ${feature}"]`),
      ).toBeNull();
    }
    expect(screen.container.textContent).toContain("Environment value: off · Not project-scoped");
    expect(mocks.calls.filter((entry) => entry.label === "policies.setFeature")).toHaveLength(0);
  });

  it("resets an overridden project feature with enabled null", async () => {
    setup();
    mocks.projects = [{ id: "project-beta", title: "Beta", environmentId: "env-1" }];
    mocks.projectSnapshots["project-beta"] = {
      ...snapshotFixture,
      features: featureStatesOf({ board: { requestedEnabled: false, effectiveEnabled: false } }),
      featureSources: { ...snapshotFixture.featureSources, board: "project" },
    };
    const resetSnapshot = {
      ...snapshotFixture,
      configVersion: 2,
      features: featureStatesOf({
        board: {
          requestedEnabled: DEFAULT_POLICY_SETTINGS.features.board,
          effectiveEnabled: DEFAULT_POLICY_SETTINGS.features.board,
        },
      }),
      featureSources: { ...snapshotFixture.featureSources, board: "default" },
    };
    mocks.commandResult = { value: { snapshot: resetSnapshot } };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("combobox", { name: "Feature toggles project" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(screen.container.textContent).toContain("Overridden");

    await userEvent.click(screen.getByRole("button", { name: "Reset board override" }));

    await vi.waitFor(() => {
      expect(mocks.calls.find((entry) => entry.label === "policies.setFeature")).toEqual({
        label: "policies.setFeature",
        input: { projectId: "project-beta", feature: "board", enabled: null },
      });
    });
    expect(screen.container.textContent).toContain("Inherited:");
  });

  it("saves a child SKILL.md with its manifest-relative file", async () => {
    setup();
    mocks.read = {
      status: "ok",
      key: "leadSkills",
      source: { kind: "doc", address: { kind: "path", relPath: "lead-skills/lead-skills.json" } },
      configured: true,
      files: [
        { file: "", content: "main file", sha256: "d".repeat(64) },
        { file: "board-orchestrator/SKILL.md", content: "skill body", sha256: "e".repeat(64) },
      ],
      mainFile: "",
    };
    mocks.commandResult = { value: { status: "saved", snapshot: snapshotFixture } };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));

    const tabs = screen.container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    const panel = screen.container.querySelector('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    for (const tab of Array.from(tabs)) {
      expect(tab.getAttribute("aria-controls")).toBe(panel!.id);
    }

    (tabs[0] as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect((tabs[1] as HTMLElement).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.textContent).toBe("board-orchestrator/SKILL.md");

    await userEvent.type(screen.getByLabelText("Edit board-orchestrator/SKILL.md"), "!");
    await userEvent.click(screen.getByText("Save and apply"));
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]!.label).toBe("policies.saveDocument");
    const input = mocks.calls[0]!.input as { file: string; content: string };
    expect(input.file).toBe("board-orchestrator/SKILL.md");
    expect(input.content).toContain("!");
  });

  it("explains which document keeps a requested feature off", async () => {
    setup();
    mocks.snapshot = {
      ...snapshotFixture,
      features: featureStatesOf({
        board: {
          id: "board",
          requestedEnabled: true,
          effectiveEnabled: false,
          offReason: { code: "feature_document_off", requirement: "rolesManifest" },
        },
      }),
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    expect(screen.container.textContent).toContain("Off: its Roles document is not valid yet.");
  });

  it("shows attention when the snapshot asks for it", async () => {
    setup();
    mocks.snapshot = { ...snapshotFixture, needsAttention: true };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    expect(screen.container.textContent).toContain("Attention:");
  });

  it("changes a document source through the policies API", async () => {
    setup();
    mocks.commandResult = { value: { snapshot: snapshotFixture } };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "doc");
    const input = screen.getByLabelText("Source store path or oc:// link");
    await userEvent.clear(input);
    await userEvent.type(input, "lead-skills/lead-skills.json");
    await userEvent.click(screen.getByText("Change source"));
    expect(mocks.calls).toEqual([
      {
        label: "policies.setDocument",
        input: {
          key: "leadSkills",
          source: {
            kind: "doc",
            address: { kind: "path", relPath: "lead-skills/lead-skills.json" },
          },
        },
      },
    ]);
    expect(screen.container.textContent).toContain("Source updated.");
  });

  it("refuses a store source that is neither a path nor a document link", async () => {
    setup();
    mocks.commandResult = { value: { snapshot: snapshotFixture } };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "doc");
    await userEvent.click(screen.getByText("Change source"));
    expect(mocks.calls).toEqual([]);
    expect(screen.container.textContent).toContain("is not a store path or an oc://doc/<id> link.");
  });

  it("lists a concrete cause per attention reason and selects the document on jump", async () => {
    setup();
    mocks.snapshot = {
      ...snapshotFixture,
      needsAttention: true,
      features: featureStatesOf({
        board: {
          id: "board",
          requestedEnabled: true,
          effectiveEnabled: false,
          offReason: { code: "feature_document_off", requirement: "rolesManifest" },
        },
      }),
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    const text = screen.container.textContent ?? "";
    expect(text).toContain(
      "Feature board is not effective: Off: its Roles document is not valid yet.",
    );
    expect(text).toContain("Roles: external change waits for review");

    await userEvent.click(
      screen.getByRole("button", { name: "Roles: external change waits for review" }),
    );
    await expect
      .element(screen.getByRole("button", { name: "Edit Roles" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("hides the banner when the snapshot has no attention cause left", async () => {
    setup();
    mocks.snapshot = {
      ...snapshotFixture,
      documents: snapshotFixture.documents.map((document) => ({
        ...document,
        pending: false,
        kept: false,
        warnings: [],
        errors: [],
      })),
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    expect(screen.container.textContent).not.toContain("Attention:");
  });

  it("fills a store document source from the Browse picker", async () => {
    setup();
    mocks.commandResult = { value: { snapshot: snapshotFixture } };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "doc");
    await userEvent.click(screen.getByRole("button", { name: "Browse store documents" }));
    // The modal dialog's inert layer swallows pointer events in this harness, so drive the DOM.
    (screen.getByText("roles.json").element() as HTMLElement).click();
    const input = screen.getByLabelText("Source store path or oc:// link");
    await vi.waitFor(() => {
      expect((input.element() as HTMLInputElement).value).toBe("roles/roles.json");
    });
    await userEvent.click(screen.getByText("Change source"));
    expect(mocks.calls).toEqual([
      {
        label: "policies.setDocument",
        input: {
          key: "leadSkills",
          source: { kind: "doc", address: { kind: "path", relPath: "roles/roles.json" } },
        },
      },
    ]);
  });

  it("filters store documents through the picker search", async () => {
    setup();
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "doc");
    await userEvent.click(screen.getByRole("button", { name: "Browse store documents" }));
    const search = screen.getByLabelText("Search documents").element() as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(search, "routing");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(mocks.queries.at(-1)).toEqual({ query: "routing" });
    });
  });

  it("fills a server file source from the Browse picker", async () => {
    setup();
    mocks.commandResult = {
      value: {
        parent: "/etc/ft3",
        directories: [{ name: "nested", path: "/etc/ft3/nested" }],
        files: [{ name: "roles.json", path: "/etc/ft3/roles.json" }],
      },
    };
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit Lead skills" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "path");
    await userEvent.click(screen.getByRole("button", { name: "Browse server files" }));
    // The picker lists the current source path's directory when it opens.
    await vi.waitFor(() => {
      expect(mocks.calls).toEqual([
        {
          label: "policies.browseServerDirectory",
          input: { directory: "/etc/ft3" },
        },
      ]);
    });
    // The modal dialog's inert layer swallows pointer events in this harness, so drive the DOM.
    (screen.getByText("roles.json").element() as HTMLElement).click();
    const input = screen.getByLabelText("Source server path");
    await vi.waitFor(() => {
      expect((input.element() as HTMLInputElement).value).toBe("/etc/ft3/roles.json");
    });
    mocks.commandResult = { value: { snapshot: snapshotFixture } };
    await userEvent.click(screen.getByText("Change source"));
    expect(mocks.calls).toEqual([
      {
        label: "policies.browseServerDirectory",
        input: { directory: "/etc/ft3" },
      },
      {
        label: "policies.setDocument",
        input: { key: "leadSkills", source: { kind: "path", path: "/etc/ft3/roles.json" } },
      },
    ]);
  });

  it("requests a fresh snapshot when the policies tab is opened again", async () => {
    setup();
    // Fixed far-future epoch: the hook floors refreshes at 10s and skips an idle
    // window (6min), so the test steps the clock by minutes between mounts.
    const openedAt = 100_000_000_000_000;
    using clock = vi.spyOn(Date, "now").mockReturnValue(openedAt);
    {
      await using first = await render(<PoliciesSettingsPanel />, { router: false });
      await expect.element(first.getByText("Routing policy")).toBeInTheDocument();
    }
    const refreshesAfterClose = mocks.refreshes.length;
    clock.mockReturnValue(openedAt + 120_000);
    await using _second = await render(<PoliciesSettingsPanel />, { router: false });
    await vi.waitFor(() => {
      expect(mocks.refreshes.length).toBeGreaterThan(refreshesAfterClose);
    });
    expect(mocks.refreshes.at(-1)).toBe("snapshot");
  });

  it("requests a fresh snapshot when the window regains focus on the policies tab", async () => {
    setup();
    const openedAt = 100_000_000_000_000;
    using clock = vi.spyOn(Date, "now").mockReturnValue(openedAt);
    await using screen = await render(<PoliciesSettingsPanel />, { router: false });
    await expect.element(screen.getByText("Routing policy")).toBeInTheDocument();
    const refreshesOnOpen = mocks.refreshes.length;
    clock.mockReturnValue(openedAt + 180_000);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      expect(mocks.refreshes.length).toBeGreaterThan(refreshesOnOpen);
    });
    expect(mocks.refreshes.at(-1)).toBe("snapshot");
  });
});
