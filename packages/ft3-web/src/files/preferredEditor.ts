import { EDITORS, type EditorId } from "@t3tools/contracts";

export function resolvePreferredEditor(
  availableEditors: ReadonlyArray<EditorId>,
  lastEditor: EditorId | null,
  allowTypora = false,
): EditorId | null {
  const eligible = new Set(availableEditors.filter((editor) => allowTypora || editor !== "typora"));
  if (lastEditor && eligible.has(lastEditor)) return lastEditor;
  return EDITORS.find((editor) => eligible.has(editor.id))?.id ?? null;
}
