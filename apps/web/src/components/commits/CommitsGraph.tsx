import "@web-git-graph/web/register";
import type { WebGitGraphElement } from "@web-git-graph/web";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import type { CommitGraphColumn, CommitGraphDateFormat } from "./commitsGraphPreferences";
import { DEFAULT_COMMIT_GRAPH_COLUMNS } from "./commitsGraphPreferences";
import {
  COMMITS_PAGE_LIMIT,
  createCommitsGraphProvider,
  loadHistoryUntilCommit,
  type CommitHistoryFetcher,
} from "./webGitGraphAdapter";

const TWO_LINE_COMMIT_LIST_STYLE = `
  .header, .row {
    grid-template-columns: var(--wgg-graph-width) minmax(0, 1fr) max-content;
    grid-template-rows: repeat(2, minmax(0, 1fr));
  }
  .header { height: 44px; }
  .header .col-graph { grid-column: 1; grid-row: 1 / span 2; }
  .header .col-description { grid-column: 2; grid-row: 1; }
  .header .col-commit { grid-column: 3; grid-row: 1; }
  .header .col-author { display: flex; grid-column: 2; grid-row: 2; }
  .header .col-date { display: flex; grid-column: 3; grid-row: 2; }
  .row { height: 44px; }
  .graph-cell { grid-column: 1; grid-row: 1 / span 2; }
  .subject { grid-column: 2; grid-row: 1; }
  .oid { grid-column: 3; grid-row: 1; }
  .row .author { display: flex; grid-column: 2; grid-row: 2; justify-content: flex-start; }
  .date { display: block; grid-column: 3; grid-row: 2; }
`;

export interface CommitsGraphProps {
  readonly environmentId: EnvironmentId;
  /** Worktree or workspace root the history is read from. */
  readonly cwd: string;
  readonly className?: string;
  readonly onError?: (error: unknown) => void;
  readonly focusCommitId?: string | null;
  readonly onCommitSelect?: (commitId: string) => void;
  readonly columns?: ReadonlyArray<CommitGraphColumn>;
  readonly dateFormat?: CommitGraphDateFormat;
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
  columns = DEFAULT_COMMIT_GRAPH_COLUMNS,
  dateFormat = "datetime",
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
    const twoLineStyle = document.createElement("style");
    twoLineStyle.textContent = TWO_LINE_COMMIT_LIST_STYLE;
    element.shadowRoot?.append(twoLineStyle);
    return () => {
      element.removeEventListener("gitgraph-error", handleError);
      element.removeEventListener("gitgraph-commit-select", handleCommitSelect);
      element.remove();
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.columns = columns.join(",");
    element.dateFormat = dateFormat;
  }, [columns, dateFormat]);

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
