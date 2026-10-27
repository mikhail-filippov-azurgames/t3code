import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { BoardCardLookupMatch } from "@t3tools/ft3-board/contracts";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
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
import { OpenContextDocChip } from "./OpenContextDocChip";
import { parseOpenContextDocHref } from "./openContextDocLink";
import { openContextEnvironment, toOpenContextDocResolveResult } from "./openContextState";

export interface Ft3MarkdownLinkInput {
  readonly href: string;
  readonly label: string;
}

export interface Ft3ChatTextExtensions {
  /** Remark plugins for upstream `ChatMarkdown`'s `extraRemarkPlugins` slot. */
  readonly remarkPlugins: ReadonlyArray<unknown>;
  /** Returns a chip for an `oc:` document or a board-card mention, else null. */
  readonly renderMarkdownLink: ((input: Ft3MarkdownLinkInput) => ReactNode | null) | undefined;
  /** True for hrefs whose scheme react-markdown would otherwise blank. */
  readonly isAllowedHref: (href: string) => boolean;
}

export interface Ft3ChatTextOptions {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly isStreaming: boolean;
}

const EMPTY_REMARK_PLUGINS: ReadonlyArray<unknown> = [];

/**
 * Board-card mentions and OpenContext document links, resolved per message.
 * The remark plugin needs the resolved matches, so both live behind one hook
 * that upstream markdown only has to call.
 */
export function useFt3ChatTextExtensions(options: Ft3ChatTextOptions): Ft3ChatTextExtensions {
  const { text, cwd, threadRef, environmentId, isStreaming } = options;
  const resolveBoardCards = useAtomQueryRunner(boardEnvironment.resolve, {
    reportFailure: false,
  });
  const resolveCommitMentionsQuery = useAtomQueryRunner(commitsEnvironment.resolveCommitMentions, {
    reportFailure: false,
  });
  const resolveOpenContextDocQuery = useAtomQueryRunner(openContextEnvironment.resolveDoc, {
    reportFailure: false,
  });

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
  useEffect(() => {
    if (environmentId === null) return;
    return subscribeBoardCardMentionCacheInvalidation(String(environmentId), () => {
      setLookupRevision((revision) => revision + 1);
    });
  }, [environmentId]);

  const [matches, setMatches] = useState<ReadonlyMap<string, BoardCardLookupMatch>>(
    EMPTY_BOARD_CARD_LOOKUP_MATCHES,
  );
  useEffect(() => {
    let current = true;
    if (environmentId === null || threadId === null || lookupTokens.length === 0) {
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
  useEffect(() => {
    let current = true;
    if (
      environmentId === null ||
      cwd === undefined ||
      threadId === null ||
      commitCandidates.length === 0
    ) {
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
      return result.value.commits;
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
        if (doc === null) return null;
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
      },
    [matches, openBoardCard, openCommit, openDocumentInPanel, resolveDoc, threadRef],
  );

  const remarkPlugins = useMemo(() => {
    const plugins: Array<() => unknown> = [];
    if (matches.size > 0) plugins.push(() => remarkLinkifyBoardCardMentions(matches));
    if (commitMatches.size > 0) plugins.push(() => remarkLinkifyCommitMentions(commitMatches));
    return plugins.length === 0 ? EMPTY_REMARK_PLUGINS : plugins;
  }, [commitMatches, matches]);

  const isAllowedHref = useCallback((href: string) => parseOpenContextDocHref(href) !== null, []);

  return { remarkPlugins, renderMarkdownLink, isAllowedHref };
}
