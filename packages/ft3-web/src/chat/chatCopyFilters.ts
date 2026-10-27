export const CHAT_COPY_SKIPPED_TAGS: ReadonlySet<string> = new Set([
  "BUTTON",
  "INPUT",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
]);

export const CHAT_COPY_SKIPPED_CLASS_NAMES: ReadonlyArray<string> = ["select-none", "sr-only"];

export const CHAT_COPY_KEPT_CHIP_CLASS_NAME = "chat-markdown-file-link";

export const CHAT_COPY_SANITIZED_HTML_SELECTOR = [
  "button",
  "input",
  "script",
  "style",
  "svg",
  '[aria-hidden="true"]',
  ...CHAT_COPY_SKIPPED_CLASS_NAMES.map((className) => `.${className}`),
].join(", ");

/** A chip's canonical text, which selection copy writes instead of its rendered chrome. */
export function chatCopyChipMarkdown(element: Element): string | null {
  return element.getAttribute("data-markdown-copy");
}

export function isChatCopyChromeElement(element: Element): boolean {
  if (CHAT_COPY_SKIPPED_TAGS.has(element.tagName) || element.localName === "svg") return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  return CHAT_COPY_SKIPPED_CLASS_NAMES.some((className) => element.classList.contains(className));
}

/**
 * Only `http(s)` links keep their destination. Internal schemes (`oc:`, `ocl:`,
 * `t3-context:`) and fragment links collapse to their label, so copying chat
 * text never leaks an in-app reference as a URI.
 */
export function chatCopyAnchorMarkdown(content: string, href: string): string {
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

/** File-link chips stay in the rich-text flavor; every other skipped node is removed. */
export function isChatCopyHtmlChipKept(element: Element): boolean {
  return (
    element.classList.contains(CHAT_COPY_KEPT_CHIP_CLASS_NAME) ||
    element.closest(`.${CHAT_COPY_KEPT_CHIP_CLASS_NAME}`) !== null
  );
}
