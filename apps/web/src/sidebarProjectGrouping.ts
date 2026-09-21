import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { buildProjectGroups, type ProjectGroupingSettings } from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktop-local environment. The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // local-device treatment instead of the generic remote treatment.
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

function normalizeDisplayPath(path: string): string {
  return path.trim().replace(/\\+/g, "/").replace(/\/+$/, "");
}

function trailingDisplayPath(path: string, segmentCount: number): string {
  const segments = normalizeDisplayPath(path)
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.slice(Math.max(0, segments.length - segmentCount)).join("/");
}

// Shortest trailing path suffix that tells apart checkouts sharing one title;
// falls back to the full path, then the environment label, so the label is
// never blank.
function projectPathDisambiguator(
  snapshot: Pick<SidebarProjectSnapshot, "workspaceRoot" | "memberProjects">,
  peers: ReadonlyArray<Pick<SidebarProjectSnapshot, "workspaceRoot" | "memberProjects">>,
): string {
  const segments = normalizeDisplayPath(snapshot.workspaceRoot).split("/").filter(Boolean);
  for (let count = 1; count <= segments.length; count += 1) {
    const suffix = trailingDisplayPath(snapshot.workspaceRoot, count);
    if (
      peers.filter((peer) => trailingDisplayPath(peer.workspaceRoot, count) === suffix).length === 1
    ) {
      return suffix;
    }
  }
  const fullPath = normalizeDisplayPath(snapshot.workspaceRoot);
  if (peers.filter((peer) => normalizeDisplayPath(peer.workspaceRoot) === fullPath).length === 1) {
    return fullPath;
  }
  return snapshot.memberProjects[0]?.environmentLabel ?? fullPath;
}

function disambiguateProjectDisplayNames(
  snapshots: ReadonlyArray<SidebarProjectSnapshot>,
): SidebarProjectSnapshot[] {
  const byDisplayName = new Map<string, SidebarProjectSnapshot[]>();
  for (const snapshot of snapshots) {
    const existing = byDisplayName.get(snapshot.displayName);
    if (existing) {
      existing.push(snapshot);
    } else {
      byDisplayName.set(snapshot.displayName, [snapshot]);
    }
  }
  return snapshots.map((snapshot) => {
    const peers = byDisplayName.get(snapshot.displayName) ?? [];
    if (peers.length <= 1) return snapshot;
    return {
      ...snapshot,
      displayName: `${snapshot.displayName} · ${projectPathDisambiguator(snapshot, peers)}`,
    };
  });
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktop-local saved-env
  // record. Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  return disambiguateProjectDisplayNames(
    buildProjectGroups({
      projects: input.projects,
      settings: input.settings,
      preferredEnvironmentId: input.primaryEnvironmentId,
    }).map((group): SidebarProjectSnapshot => {
      const members = group.members.map(
        ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
          ...project,
          physicalProjectKey,
          environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
        }),
      );
      const representative =
        members.find(
          (member) =>
            member.environmentId === group.representative.environmentId &&
            member.id === group.representative.id,
        ) ?? members[0]!;

      const hasLocal =
        input.primaryEnvironmentId !== null &&
        members.some((member) => member.environmentId === input.primaryEnvironmentId);
      const hasRemote =
        input.primaryEnvironmentId !== null
          ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
          : false;
      const remoteMembers = members.filter(
        (member) =>
          input.primaryEnvironmentId !== null &&
          member.environmentId !== input.primaryEnvironmentId,
      );
      const remoteEnvironmentLabels = remoteMembers
        .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
        .filter((label, index, labels) => labels.indexOf(label) === index);
      const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
      const isWsl = input.isWslEnvironment ?? (() => false);
      const allRemoteMembersAreDesktopLocal =
        remoteMembers.length > 0 &&
        remoteMembers.every((member) => isDesktopLocal(member.environmentId));
      const allRemoteMembersAreWsl =
        remoteMembers.length > 0 && remoteMembers.every((member) => isWsl(member.environmentId));

      return {
        ...representative,
        projectKey: group.key,
        displayName: group.label,
        groupedProjectCount: members.length,
        environmentPresence:
          hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
        allRemoteMembersAreDesktopLocal,
        allRemoteMembersAreWsl,
        memberProjects: members,
        memberProjectRefs: group.memberProjectRefs,
        remoteEnvironmentLabels,
      };
    }),
  );
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === preferredProjectRef.environmentId,
        ))
      : null;
    const targetProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  return [
    entries[preferredIndex]!,
    ...entries.slice(0, preferredIndex),
    ...entries.slice(preferredIndex + 1),
  ];
}
