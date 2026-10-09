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
  loadHistoryUntilCommit,
  type CommitHistoryFetcher,
} from "./webGitGraphAdapter";

export interface CommitsGraphProps {
  readonly environmentId: EnvironmentId;
  /** Worktree or workspace root the history is read from. */
  readonly cwd: string;
  readonly className?: string;
  readonly onError?: (error: unknown) => void;
  readonly focusCommitId?: string | null;
  readonly onCommitSelect?: (commitId: string) => void;
}

/**
 * Thin host for the `<web-git-graph>` custom element: it owns nothing but the
 * data and incoming selection bridge, so mounting it only when its tab opens
 * defers history reads until the user opens that tab.
 */
export function CommitsGraph({
  environmentId,
  cwd,
  className,
  onError,
  focusCommitId = null,
  onCommitSelect,
}: CommitsGraphProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<WebGitGraphElement | null>(null);
  const errorHandlerRef = useRef(onError);
  const commitSelectHandlerRef = useRef(onCommitSelect);
  const { resolvedTheme } = useTheme();
  const runListCommitHistory = useAtomCommand(vcsEnvironment.listCommitHistory);

  useEffect(() => {
    errorHandlerRef.current = onError;
  }, [onError]);

  useEffect(() => {
    commitSelectHandlerRef.current = onCommitSelect;
  }, [onCommitSelect]);

  const fetchPage = useCallback<CommitHistoryFetcher>(
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
  const pageRequests = useMemo(
    () => new Map<string, ReturnType<CommitHistoryFetcher>>(),
    [cwd, environmentId],
  );
  const fetcher = useCallback<CommitHistoryFetcher>(
    (input) => {
      const key = input.cursor ? `${input.cursor.id}:${input.cursor.offset}` : "first";
      const existing = pageRequests.get(key);
      if (existing) return existing;
      const request = fetchPage(input);
      pageRequests.set(key, request);
      void request.then(
        () => pageRequests.delete(key),
        () => pageRequests.delete(key),
      );
      return request;
    },
    [fetchPage, pageRequests],
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
    const handleCommitSelect = (event: Event) => {
      const detail = (event as CustomEvent<{ commit?: { oid?: string } }>).detail;
      if (detail?.commit?.oid) commitSelectHandlerRef.current?.(detail.commit.oid);
    };
    element.addEventListener("gitgraph-error", handleError);
    element.addEventListener("gitgraph-commit-select", handleCommitSelect);
    host.append(element);
    return () => {
      element.removeEventListener("gitgraph-error", handleError);
      element.removeEventListener("gitgraph-commit-select", handleCommitSelect);
      element.remove();
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !focusCommitId) return;
    let cancelled = false;
    if (element.data.commits.some((commit) => commit.oid === focusCommitId)) {
      element.selectCommit(focusCommitId);
      element.focusCommit(focusCommitId);
      return;
    }
    void loadHistoryUntilCommit(fetcher, focusCommitId, (page) => {
      if (!cancelled) element.appendPage(page);
    })
      .then((found) => {
        if (!found || cancelled) return;
        element.selectCommit(focusCommitId);
        element.focusCommit(focusCommitId);
      })
      .catch((error: unknown) => {
        if (!cancelled) errorHandlerRef.current?.(error);
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, focusCommitId]);

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
