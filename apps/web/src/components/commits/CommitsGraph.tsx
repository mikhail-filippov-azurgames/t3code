import "@web-git-graph/web/register";
import type { WebGitGraphElement } from "@web-git-graph/web";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import {
  COMMITS_PAGE_LIMIT,
  createCommitsGraphProvider,
  type CommitHistoryFetcher,
} from "./webGitGraphAdapter";

export interface CommitsGraphProps {
  readonly environmentId: EnvironmentId;
  /** Worktree or workspace root the history is read from. */
  readonly cwd: string;
  readonly className?: string;
  readonly onError?: (error: unknown) => void;
}

/**
 * Thin host for the `<web-git-graph>` custom element: it owns nothing but the
 * data bridge, so the panel can mount and unmount it without the graph holding
 * on to component state.
 */
export function CommitsGraph({ environmentId, cwd, className, onError }: CommitsGraphProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<WebGitGraphElement | null>(null);
  const errorHandlerRef = useRef(onError);
  const { resolvedTheme } = useTheme();
  const runListCommitHistory = useAtomCommand(vcsEnvironment.listCommitHistory);

  useEffect(() => {
    errorHandlerRef.current = onError;
  }, [onError]);

  const fetcher = useCallback<CommitHistoryFetcher>(
    async ({ cursor, limit }) => {
      const result = await runListCommitHistory({
        environmentId,
        input: { cwd, limit, ...(cursor === undefined ? {} : { cursor }) },
      });
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    [cwd, environmentId, runListCommitHistory],
  );
  const provider = useMemo(() => createCommitsGraphProvider(fetcher), [fetcher]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const element = document.createElement("web-git-graph");
    element.setAttribute("columns", "author,date");
    element.setAttribute("date-format", "datetime");
    element.style.height = "100%";
    elementRef.current = element;
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ error?: unknown }>).detail;
      errorHandlerRef.current?.(detail?.error ?? event);
    };
    element.addEventListener("gitgraph-error", handleError);
    host.append(element);
    return () => {
      element.removeEventListener("gitgraph-error", handleError);
      element.remove();
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (element) element.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const element = elementRef.current;
    if (element) element.provider = provider;
  }, [provider]);

  return <div ref={hostRef} className={className} />;
}
