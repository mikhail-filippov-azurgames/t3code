import "@web-git-graph/web/register";
import type { WebGitGraphElement } from "@web-git-graph/web";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { commitsEnvironment } from "./state.ts";
import type { CommitGraphColumn, CommitGraphDateFormat } from "./commitsGraphPreferences.ts";
import { DEFAULT_COMMIT_GRAPH_COLUMNS } from "./commitsGraphPreferences.ts";
import { createCommitSelectionBridge } from "./commitsGraphSelection.ts";
import {
  createCommitsGraphProvider,
  loadHistoryUntilCommit,
  type CommitHistoryFetcher,
} from "./webGitGraphAdapter.ts";

const NARROW_COMMIT_LIST_STYLE = `
  @container wgg (max-width: 760px) {
    .refs { max-width: 45%; overflow: hidden; }
    .ref {
      display: block;
      flex: 0 1 auto;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
  @container wgg (max-width: 420px) {
    .header, .row {
      grid-template-columns: var(--wgg-graph-width) minmax(0, 1fr);
    }
    .col-commit, .oid { display: none; }
    .spacer {
      min-width: max(100%, calc(var(--wgg-graph-width) + 160px));
    }
  }
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
  const commitSelectionBridgeRef = useRef<ReturnType<typeof createCommitSelectionBridge> | null>(
    null,
  );
  const { resolvedTheme } = useTheme();
  const runListCommitHistory = useAtomCommand(commitsEnvironment.listCommitHistory);
  const refsQuery = useEnvironmentQuery(
    commitsEnvironment.listRefs({ environmentId, input: { cwd } }),
  );
  const repositoryRefs = refsQuery.data?.refs;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest onError handler in a ref for the custom element's event listeners
  useEffect(() => {
    errorHandlerRef.current = onError;
  }, [onError]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest onCommitSelect handler in a ref for the selection bridge
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
  // In-flight page cache keyed by repository; self-invalidates when cwd or environmentId changes.
  const pageRequestsRef = useRef<{
    key: string;
    requests: Map<string, ReturnType<CommitHistoryFetcher>>;
  }>({
    key: "",
    requests: new Map(),
  });
  const fetcher = useCallback<CommitHistoryFetcher>(
    (input) => {
      const cacheKey = `${environmentId}:${cwd}`;
      let cache = pageRequestsRef.current;
      if (cache.key !== cacheKey) {
        cache = { key: cacheKey, requests: new Map() };
        pageRequestsRef.current = cache;
      }
      const key = input.cursor ? `${input.cursor.id}:${input.cursor.offset}` : "first";
      const existing = cache.requests.get(key);
      if (existing) return existing;
      const request = fetchPage(input);
      cache.requests.set(key, request);
      void request.then(
        () => cache.requests.delete(key),
        () => cache.requests.delete(key),
      );
      return request;
    },
    [cwd, environmentId, fetchPage],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the web-git-graph custom element lifecycle: creates it on mount and removes it on unmount
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const element = document.createElement("web-git-graph");
    element.style.height = "100%";
    elementRef.current = element;
    const bridge = createCommitSelectionBridge((commitId) =>
      commitSelectHandlerRef.current?.(commitId),
    );
    commitSelectionBridgeRef.current = bridge;
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ error?: unknown }>).detail;
      errorHandlerRef.current?.(detail?.error ?? event);
    };
    const handleCommitSelect = (event: Event) => {
      const detail = (event as CustomEvent<{ commit?: { oid?: string } }>).detail;
      if (detail?.commit?.oid) bridge.handleSelect(detail.commit.oid);
    };
    element.addEventListener("gitgraph-error", handleError);
    element.addEventListener("gitgraph-commit-select", handleCommitSelect);
    host.append(element);
    const narrowStyle = document.createElement("style");
    narrowStyle.textContent = NARROW_COMMIT_LIST_STYLE;
    element.shadowRoot?.append(narrowStyle);
    return () => {
      element.removeEventListener("gitgraph-error", handleError);
      element.removeEventListener("gitgraph-commit-select", handleCommitSelect);
      element.remove();
      elementRef.current = null;
      commitSelectionBridgeRef.current = null;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the column and date format props into the custom element
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.columns = columns.join(",");
    element.dateFormat = dateFormat;
  }, [columns, dateFormat]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages history in until the focused commit exists, then focuses it; cancels on change or unmount
  useEffect(() => {
    const element = elementRef.current;
    if (!element || !focusCommitId) return;
    const bridge = commitSelectionBridgeRef.current;
    if (!bridge) return;
    let cancelled = false;
    if (element.data.commits.some((commit) => commit.oid === focusCommitId)) {
      bridge.selectForFocus(focusCommitId, (commitId) => element.selectCommit(commitId));
      element.focusCommit(focusCommitId);
      return;
    }
    void loadHistoryUntilCommit(fetcher, focusCommitId, (page) => {
      if (!cancelled) element.appendPage(page);
    })
      .then((found) => {
        if (!found || cancelled) return;
        bridge.selectForFocus(focusCommitId, (commitId) => element.selectCommit(commitId));
        element.focusCommit(focusCommitId);
      })
      .catch((error: unknown) => {
        if (!cancelled) errorHandlerRef.current?.(error);
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, focusCommitId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the resolved theme into the custom element
  useEffect(() => {
    const element = elementRef.current;
    if (element) element.theme = resolvedTheme;
  }, [resolvedTheme]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- builds the data provider and pushes it into the custom element
  useEffect(() => {
    const element = elementRef.current;
    if (element) element.provider = createCommitsGraphProvider(fetcher, repositoryRefs ?? []);
  }, [fetcher, repositoryRefs]);

  return <div ref={hostRef} className={className} />;
}
