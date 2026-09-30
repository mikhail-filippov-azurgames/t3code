/**
 * Second pass over Mermaid SVG before it is inserted with
 * `dangerouslySetInnerHTML`. Mermaid's `securityLevel: "strict"` already runs
 * DOMPurify and encodes HTML labels; this strips residual script-capable SVG
 * in case a diagram type emits it anyway (foreignObject, event handlers,
 * script URLs, external `link` loads).
 */

const DROP_ELEMENTS_WITH_CONTENT = [
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "frame",
  "frameset",
  "meta",
  "base",
  "form",
  "input",
  "select",
  "textarea",
  "button",
  "img",
] as const;

const DROP_ELEMENTS = [
  "link",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "handler",
  "annotation-xml",
] as const;

const EVENT_HANDLER_ATTRIBUTE = /\son[a-z0-9-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;

const URL_ATTRIBUTE =
  /\s(?:xlink:href|href|src|from|to|values|by|begin|formaction|datasrc|datafld)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;

const UNSAFE_URL_PROTOCOL = /^(?:javascript|vbscript|data|file|blob):/iu;

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&amp;/giu, "&")
    .replace(/&tab;/giu, "\t")
    .replace(/&newline;/giu, "\n");
}

function isUnsafeUrl(value: string): boolean {
  const decoded = decodeBasicEntities(value).replace(/[\u0000-\u0020]+/gu, "");
  return UNSAFE_URL_PROTOCOL.test(decoded);
}

/** Diagram theming lives in `<style>`; keep it, but not CSS-borne script URLs. */
function neutralizeStyleBlocks(svg: string): string {
  return svg.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu, (_match, css: string) => {
    const safeCss = css
      .replace(/@import[^;]*;/giu, "")
      .replace(/expression\s*\(/giu, "blocked(")
      .replace(/(?:javascript|vbscript)\s*:/giu, "blocked:");
    return `<style>${safeCss}</style>`;
  });
}

export function sanitizeMermaidSvg(svg: string): string {
  let result = svg;
  for (const element of DROP_ELEMENTS_WITH_CONTENT) {
    result = result.replace(
      new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}\\s*>`, "giu"),
      "",
    );
  }
  for (const element of [...DROP_ELEMENTS_WITH_CONTENT, ...DROP_ELEMENTS]) {
    result = result.replace(new RegExp(`<\\/?${element}\\b[^>]*>`, "giu"), "");
  }
  result = neutralizeStyleBlocks(result);
  result = result.replace(EVENT_HANDLER_ATTRIBUTE, "");
  result = result.replace(URL_ATTRIBUTE, (match, doubleQuoted, singleQuoted, unquoted) =>
    isUnsafeUrl(doubleQuoted ?? singleQuoted ?? unquoted ?? "") ? "" : match,
  );
  return result;
}
