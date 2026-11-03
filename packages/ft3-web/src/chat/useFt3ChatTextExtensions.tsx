import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { AuthFilesystemReadScope } from "@t3tools/contracts";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { BoardCardLookupMatch } from "@t3tools/ft3-board/contracts";
import {
  claimWorkspaceBasenameLookup,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "~/markdown-links";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { addBoardCardPin } from "../board/boardCardPins";
import { boardEnvironment } from "../board/state";
import { selectCommitFromGraph } from "../commits/commitsPanel.logic.ts";
import { commitsEnvironment } from "../commits/state";
import { BoardCardMentionButton } from "./BoardCardMentionChip";
import {
  EMPTY_BOARD_CARD_LOOKUP_MATCHES,
  EMPTY_BOARD_CARD_LOOKUP_TOKENS,
  boardCardMentionLookupKey,
  extractBoardCardLookupTokens,
  resolveBoardCardMentions,
  subscribeBoardCardMentionCacheInvalidation,
} from "./boardCardMentions";
import {
  BOARD_CARD_MENTION_HREF_PREFIX,
  remarkLinkifyBoardCardMentions,
} from "./boardCardMentionsPlugin";
import { CommitMentionChip } from "./CommitMentionChip";
import {
  EMPTY_COMMIT_MENTION_MATCHES,
  EMPTY_COMMIT_MENTIONS,
  extractCommitMentions,
  resolveCommitMentions,
} from "./commitMentions";
import { COMMIT_MENTION_HREF_PREFIX, remarkLinkifyCommitMentions } from "./commitMentionsPlugin";
import {
  cacheWorkspaceMatch,
  normalizeWorkspaceRelativePath,
  readCachedWorkspaceMatch,
  resolveWorkspaceRelativeMatch,
  workspaceLookupQuery,
  workspaceMatchCacheKey,
  workspaceParentDirectory,
} from "./chatFileLink";
import { MissingFileLinkChip } from "./MissingFileLinkChip";
import { OpenContextDocChip } from "./OpenContextDocChip";
import { parseOpenContextDocHref } from "./openContextDocLink";
import { docsEnvironment, toOpenContextDocResolveResult } from "./openContextState";

export interface Ft3MarkdownLinkInput {
  readonly href: string;
  readonly label: string;
}

export interface Ft3OpenFileLinkInput {
  readonly meta: MarkdownFileLinkMeta;
  readonly panelPath: string;
  readonly line: number | undefined;
  /** Upstream's own open; used whenever this resolver cannot conclude. */
  readonly fallback: () => void;
}

export interface Ft3ChatTextExtensions {
  /** Remark plugins for upstream `ChatMarkdown`'s `extraRemarkPlugins` slot. */
  readonly remarkPlugins: ReadonlyArray<unknown>;
  /** Returns a chip for an `oc:` document, a board-card mention, or a missing file. */
  readonly renderMarkdownLink: ((input: Ft3MarkdownLinkInput) => ReactNode | null) | undefined;
  /** True for hrefs whose scheme react-markdown would otherwise blank. */
  readonly isAllowedHref: (href: string) => boolean;
  /** Resolves a workspace-relative file link, including nested suffixes and missing targets. */
  readonly openFileLink: ((input: Ft3OpenFileLinkInput) => Promise<void>) | undefined;
}

export interface Ft3ChatTextOptions {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly isStreaming: boolean;
  readonly fileLinkBaseDir?: string | undefined;
}

const EMPTY_REMARK_PLUGINS: ReadonlyArray<unknown> = [];
const EMPTY_MISSING_FILE_TARGETS: ReadonlySet<string> = new Set();

/**
 * Board-card mentions and OpenContext document links, resolved per message.
 * The remark plugin needs the resolved matches, so both live behind one hook
 * that upstream markdown only has to call.
 */
export function useFt3ChatTextExtensions(options: Ft3ChatTextOptions): Ft3ChatTextExtensions {
  const { text, cwd, threadRef, environmentId, isStreaming, fileLinkBaseDir } = options;
  const resolveBoardCards = useAtomQueryRunner(boardEnvironment.resolve, {
    reportFailure: false,
  });
  const resolveCommitMentionsQuery = useAtomQueryRunner(commitsEnvironment.resolveCommitMentions, {
    reportFailure: false,
  });
  const resolveOpenContextDocQuery = useAtomQueryRunner(docsEnvironment.resolveDoc, {
    reportFailure: false,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const listProjectEntries = useAtomQueryRunner(projectEnvironment.listEntries, {
    reportFailure: false,
  });
  const resolvedTheme = useRenderedAppearance();

  const threadId = threadRef?.threadId ?? null;
  const lookupText = isStreaming || threadId === null || environmentId === null ? null : text;
  const lookupTokens = useMemo(
    () =>
      lookupText === null
        ? EMPTY_BOARD_CARD_LOOKUP_TOKENS
        : extractBoardCardLookupTokens(lookupText),
    [lookupText],
  );
  const [lookupRevision, setLookupRevision] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the board mention cache
  useEffect(() => {
    if (environmentId === null) return;
    return subscribeBoardCardMentionCacheInvalidation(String(environmentId), () => {
      setLookupRevision((revision) => revision + 1);
    });
  }, [environmentId]);

  const [matches, setMatches] = useState<ReadonlyMap<string, BoardCardLookupMatch>>(
    EMPTY_BOARD_CARD_LOOKUP_MATCHES,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves board mentions over RPC
  useEffect(() => {
    let current = true;
    if (environmentId === null || threadId === null || lookupTokens.length === 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- drops the previous lookup's matches
      setMatches(EMPTY_BOARD_CARD_LOOKUP_MATCHES);
      return () => {
        current = false;
      };
    }
    void resolveBoardCardMentions(String(environmentId), lookupTokens, async (tokens) => {
      const result = await resolveBoardCards({
        environmentId,
        input: { tokens, cardIds: [] },
      });
      if (!AsyncResult.isSuccess(result)) throw result.cause;
      return result.value.matches;
    }).then(
      (resolved) => {
        if (!current) return;
        const confirmed = new Map<string, BoardCardLookupMatch>();
        for (const [token, match] of resolved) {
          if (match) confirmed.set(token, match);
        }
        setMatches(confirmed);
      },
      () => {},
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- lookupRevision reruns the lookup after cache invalidation
  }, [environmentId, lookupRevision, lookupTokens, resolveBoardCards, threadId]);

  const commitLookupText =
    isStreaming || threadId === null || environmentId === null || cwd === undefined ? null : text;
  const commitCandidates = useMemo(
    () =>
      commitLookupText === null ? EMPTY_COMMIT_MENTIONS : extractCommitMentions(commitLookupText),
    [commitLookupText],
  );
  const [commitMatches, setCommitMatches] = useState<ReadonlyMap<string, string>>(
    EMPTY_COMMIT_MENTION_MATCHES,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves commit mentions over RPC
  useEffect(() => {
    let current = true;
    if (
      environmentId === null ||
      cwd === undefined ||
      threadId === null ||
      commitCandidates.length === 0
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- drops the previous lookup's matches
      setCommitMatches(EMPTY_COMMIT_MENTION_MATCHES);
      return () => {
        current = false;
      };
    }
    const shaCandidates = [...new Set(commitCandidates.map(({ sha }) => sha))];
    void resolveCommitMentions(String(environmentId), cwd, shaCandidates, async (candidates) => {
      const result = await resolveCommitMentionsQuery({
        environmentId,
        input: { cwd, candidates },
      });
      if (!AsyncResult.isSuccess(result)) throw result.cause;
      return result.value.commits.map((mention) => mention.commit);
    }).then(
      (resolved) => {
        if (!current) return;
        const byToken = new Map<string, string>();
        for (const mention of commitCandidates) {
          const sha = resolved.get(mention.sha);
          if (sha) {
            byToken.set(mention.token, sha);
            byToken.set(mention.sha, sha);
          }
        }
        setCommitMatches(byToken);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [commitCandidates, cwd, environmentId, resolveCommitMentionsQuery, threadId]);

  const resolveDoc = useCallback(
    async (stableId: string) => {
      if (environmentId === null) return null;
      const result = await resolveOpenContextDocQuery({
        environmentId,
        input: { stableId },
      });
      if (!AsyncResult.isSuccess(result)) return null;
      return toOpenContextDocResolveResult(result.value);
    },
    [environmentId, resolveOpenContextDocQuery],
  );

  const openBoardCard = useCallback(
    (cardId: string) => {
      if (environmentId === null || threadRef === undefined) return;
      addBoardCardPin(environmentId, threadRef.threadId, cardId);
    },
    [environmentId, threadRef],
  );

  const openCommit = useCallback(
    (sha: string) => {
      if (threadRef === undefined) return;
      selectCommitFromGraph({
        threadRef,
        commitId: sha,
        diffOpen:
          selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "diff",
        selectCommit: useDiffPanelStore.getState().selectCommit,
        openDiffPanel: (ref) => useRightPanelStore.getState().open(ref, "diff"),
      });
    },
    [threadRef],
  );

  const openDocumentInPanel = useCallback(
    (absolutePath: string) => {
      if (threadRef === undefined) return;
      useRightPanelStore.getState().openFile(threadRef, absolutePath);
    },
    [threadRef],
  );

  const fileLinkScope = [
    text,
    cwd,
    threadRef?.environmentId,
    threadRef?.threadId,
    environmentId,
    fileLinkBaseDir,
  ].join("\u0000");
  const [missingFileTargets, setMissingFileTargets] = useState<ReadonlySet<string>>(
    EMPTY_MISSING_FILE_TARGETS,
  );
  const [missingFileScope, setMissingFileScope] = useState(fileLinkScope);
  if (missingFileScope !== fileLinkScope) {
    setMissingFileScope(fileLinkScope);
    setMissingFileTargets(EMPTY_MISSING_FILE_TARGETS);
  }

  const markFileMissing = useCallback((targetPath: string) => {
    setMissingFileTargets((current) => {
      if (current.has(targetPath)) return current;
      const next = new Set(current);
      next.add(targetPath);
      return next;
    });
  }, []);

  const findWorkspaceMatchResolution = useCallback(
    async (workspaceRelativePath: string) => {
      if (
        cwd === undefined ||
        environmentId === null ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
      ) {
        return null;
      }
      const cacheKey = workspaceMatchCacheKey(cwd, workspaceRelativePath);
      const cached = readCachedWorkspaceMatch(cacheKey);
      if (cached.hit) {
        return cached.value !== null
          ? ({ kind: "resolved", path: cached.value } as const)
          : ({ kind: "none" } as const);
      }
      const result = await searchProjectEntries({
        environmentId,
        input: {
          cwd,
          query: workspaceLookupQuery(workspaceRelativePath),
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          kind: "file",
        },
      });
      if (!AsyncResult.isSuccess(result)) return null;
      const resolution = resolveWorkspaceRelativeMatch(workspaceRelativePath, result.value.entries);
      // An ambiguous hit is not a stable answer to cache: a later index change
      // can make it resolvable.
      if (resolution.kind !== "ambiguous") {
        cacheWorkspaceMatch(cacheKey, resolution.kind === "resolved" ? resolution.path : null);
      }
      return resolution;
    },
    [cwd, environmentId, searchProjectEntries],
  );

  const findWorkspaceEntryKind = useCallback(
    async (
      workspaceRelativePath: string,
    ): Promise<"file" | "directory" | "missing" | "unknown"> => {
      if (cwd === undefined || environmentId === null) return "unknown";
      const parent = workspaceParentDirectory(workspaceRelativePath);
      const result = await listProjectEntries({
        environmentId,
        input: { cwd, ...(parent.length > 0 ? { directoryPath: parent } : {}) },
      });
      if (!AsyncResult.isSuccess(result)) return "unknown";
      const target = normalizeWorkspaceRelativePath(workspaceRelativePath);
      const entry = result.value.entries.find(
        (candidate) => normalizeWorkspaceRelativePath(candidate.path) === target,
      );
      return entry?.kind ?? "missing";
    },
    [cwd, environmentId, listProjectEntries],
  );

  const openFileLink = useCallback(
    async (input: Ft3OpenFileLinkInput) => {
      const { meta, panelPath, line, fallback } = input;
      const lookupPath = meta.workspaceLookupPath;
      if (
        threadRef === undefined ||
        lookupPath === null ||
        (cwd !== undefined && stripRepeatedWorkspacePrefix(lookupPath, cwd) !== null)
      ) {
        fallback();
        return;
      }
      const isLatestLookup = claimWorkspaceBasenameLookup();
      const openAt = (path: string) =>
        useRightPanelStore.getState().openFile(threadRef, path, line);

      const resolution = await findWorkspaceMatchResolution(lookupPath);
      if (!isLatestLookup()) return;
      if (resolution === null) return;
      if (resolution.kind === "resolved") {
        openAt(resolution.path);
        return;
      }
      if (resolution.kind === "ambiguous") return;

      const kind = await findWorkspaceEntryKind(lookupPath);
      if (!isLatestLookup()) return;
      if (kind === "file" || kind === "directory") {
        openAt(panelPath);
        return;
      }
      if (kind === "missing") {
        markFileMissing(meta.targetPath);
        return;
      }
      fallback();
    },
    [cwd, findWorkspaceEntryKind, findWorkspaceMatchResolution, markFileMissing, threadRef],
  );

  const renderMarkdownLink = useMemo(
    () =>
      (input: Ft3MarkdownLinkInput): ReactNode | null => {
        if (input.href.startsWith(BOARD_CARD_MENTION_HREF_PREFIX)) {
          const match = matches.get(boardCardMentionLookupKey(input.label));
          if (match === undefined || threadRef === undefined) return null;
          return <BoardCardMentionButton match={match} onPin={openBoardCard} />;
        }
        if (input.href.startsWith(COMMIT_MENTION_HREF_PREFIX)) {
          if (threadRef === undefined) return null;
          return (
            <CommitMentionChip
              sha={input.href.slice(COMMIT_MENTION_HREF_PREFIX.length)}
              label={input.label}
              onOpen={openCommit}
            />
          );
        }
        const doc = parseOpenContextDocHref(input.href);
        if (doc !== null) {
          return (
            <OpenContextDocChip
              href={doc.href}
              stableId={doc.stableId}
              resolvable={doc.scheme === "oc"}
              label={input.label.trim() || doc.stableId}
              canOpenDocument={threadRef !== undefined}
              resolveDoc={resolveDoc}
              onOpenDocument={openDocumentInPanel}
            />
          );
        }
        if (missingFileTargets.size === 0 || cwd === undefined) return null;
        const meta = resolveMarkdownFileLinkMeta(input.href, cwd, fileLinkBaseDir ?? cwd);
        if (meta === null || !missingFileTargets.has(meta.targetPath)) return null;
        return (
          <MissingFileLinkChip
            environmentId={environmentId}
            targetPath={meta.targetPath}
            iconPath={meta.filePath}
            label={meta.line !== undefined ? `${meta.basename} · L${meta.line}` : meta.basename}
            copyMarkdown={`[${meta.basename}](${input.href})`}
            theme={resolvedTheme}
          />
        );
      },
    [
      cwd,
      environmentId,
      fileLinkBaseDir,
      matches,
      missingFileTargets,
      openBoardCard,
      openCommit,
      openDocumentInPanel,
      resolveDoc,
      resolvedTheme,
      threadRef,
    ],
  );

  const remarkPlugins = useMemo(() => {
    const plugins: Array<() => unknown> = [];
    if (matches.size > 0) plugins.push(() => remarkLinkifyBoardCardMentions(matches));
    if (commitMatches.size > 0) plugins.push(() => remarkLinkifyCommitMentions(commitMatches));
    return plugins.length === 0 ? EMPTY_REMARK_PLUGINS : plugins;
  }, [commitMatches, matches]);

  const isAllowedHref = useCallback((href: string) => parseOpenContextDocHref(href) !== null, []);

  return { remarkPlugins, renderMarkdownLink, isAllowedHref, openFileLink };
}
