import { createFileRoute, redirect } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { CommitsGraph } from "../components/commits/CommitsGraph";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

/**
 * Measurement harness for slice 2 of the commits tab: it mounts the real
 * `CommitsGraph` against a real environment and worktree so scroll, memory and
 * lane continuity can be read from the running app. The panel tab (slice 5)
 * replaces this route.
 */
function CommitsLab() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [projectKey, setProjectKey] = useState("");
  const [cwdOverride, setCwdOverride] = useState("");

  const project =
    projects.find((entry) => `${entry.environmentId}:${entry.id}` === projectKey) ??
    projects[0] ??
    null;
  const environmentId: EnvironmentId | null =
    project?.environmentId ?? primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
  const cwd = cwdOverride.trim().length > 0 ? cwdOverride.trim() : (project?.workspaceRoot ?? "");

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">Commits lab (prototype)</span>
        <select
          className="rounded border bg-background px-2 py-1"
          value={projectKey}
          onChange={(event) => {
            setProjectKey(event.target.value);
            setCwdOverride("");
          }}
        >
          {projects.map((entry) => (
            <option
              key={`${entry.environmentId}:${entry.id}`}
              value={`${entry.environmentId}:${entry.id}`}
            >
              {entry.title} — {entry.workspaceRoot}
            </option>
          ))}
        </select>
        <input
          className="min-w-[320px] flex-1 rounded border bg-background px-2 py-1 font-mono"
          placeholder="worktree path"
          value={cwd}
          onChange={(event) => setCwdOverride(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1">
        {environmentId !== null && cwd.length > 0 ? (
          <CommitsGraph
            key={`${environmentId}|${cwd}`}
            environmentId={environmentId}
            cwd={cwd}
            className="h-full"
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            No project or worktree selected.
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/commits-lab")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CommitsLab,
});
