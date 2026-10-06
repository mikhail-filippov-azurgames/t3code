import { useMemo } from "react";
import { View } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  linkifyNativeBoardCardMentions,
  nativeMarkdownWithPreservedSoftBreaks,
} from "./nativeMarkdownText";
import { MarkdownImageRendererContext, NativeMarkdownBlock } from "./NativeMarkdownBlock";
import {
  MarkdownContextClipboardContext,
  MarkdownFileContextMenuContext,
  NativeMarkdownSelectableText,
  type MarkdownFileContextMenuHandlers,
} from "./NativeMarkdownSelectableText";
import type {
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

const EMPTY_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = [];
const EMPTY_BOARD_CARD_MATCHES = new Map();

export type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText({
  markdown,
  contextClipboardFragment,
  skills = EMPTY_SKILLS,
  textStyle,
  highlightCode,
  preserveSoftBreaks = false,
  onLinkPress,
  fileContextMenu,
  onFileContextMenuAction,
  boardCardMatches = EMPTY_BOARD_CARD_MATCHES,
  renderImage,
  marginTop = 0,
  marginBottom = 0,
}: SelectableMarkdownTextProps) {
  const chunks = useMemo(() => {
    const parsedDocument = parseMarkdownWithOptions(markdown, {
      gfm: true,
      html: true,
      math: false,
    });
    const documentWithSoftBreaks = preserveSoftBreaks
      ? nativeMarkdownWithPreservedSoftBreaks(parsedDocument)
      : parsedDocument;
    const document = linkifyNativeBoardCardMentions(documentWithSoftBreaks, boardCardMatches);
    return nativeMarkdownDocumentChunks(document).map((chunk) =>
      chunk.kind === "selectable"
        ? {
            ...chunk,
            runs: nativeMarkdownDocumentRuns(chunk.node, skills),
          }
        : chunk,
    );
  }, [boardCardMatches, markdown, preserveSoftBreaks, skills]);

  const fileContextMenuHandlers = useMemo<MarkdownFileContextMenuHandlers | null>(
    () =>
      fileContextMenu && onFileContextMenuAction
        ? { fileContextMenu, onFileContextMenuAction }
        : null,
    [fileContextMenu, onFileContextMenuAction],
  );

  return (
    <MarkdownContextClipboardContext.Provider value={contextClipboardFragment ?? ""}>
      <MarkdownImageRendererContext.Provider value={renderImage ?? null}>
        <MarkdownFileContextMenuContext.Provider value={fileContextMenuHandlers}>
          {/* A percentage width here creates a cyclic intrinsic measurement inside
          shrink-to-fit containers such as user-message bubbles. Yoga then gives
          the native text node an unbounded second pass and the parent only clips
          the resulting single-line width instead of reflowing it. */}
          <View style={{ flexShrink: 1, minWidth: 0, marginTop, marginBottom }}>
            {chunks.map((chunk, index) => {
              const content =
                chunk.kind === "rich" ? (
                  <NativeMarkdownBlock
                    node={chunk.node}
                    skills={skills}
                    textStyle={textStyle}
                    highlightCode={highlightCode}
                    onLinkPress={onLinkPress}
                  />
                ) : (
                  <NativeMarkdownSelectableText
                    runs={chunk.runs}
                    textStyle={textStyle}
                    onLinkPress={onLinkPress}
                  />
                );

              return (
                <View
                  key={chunk.key}
                  style={{ paddingTop: nativeMarkdownChunkSpacing(chunks[index - 1], chunk) }}
                >
                  {content}
                </View>
              );
            })}
          </View>
        </MarkdownFileContextMenuContext.Provider>
      </MarkdownImageRendererContext.Provider>
    </MarkdownContextClipboardContext.Provider>
  );
}
