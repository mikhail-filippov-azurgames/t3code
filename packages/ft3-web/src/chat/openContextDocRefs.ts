import { parseOpenContextDocHref, type OpenContextDocHref } from "./openContextDocLink.ts";

/**
 * A bare reference runs to the next whitespace; the run is a document only when
 * the href parser accepts all of it, so `oc://doc/a/b` and a trailing query stay
 * plain text instead of becoming a chip for a shortened id.
 */
const BARE_DOC_REF_PATTERN = /(^|[^A-Za-z0-9+.:/_-])((?:oc|ocl):\/\/doc\/\S+)/giu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?'")\]}]+$/u;

export interface OpenContextDocTextSegment {
  readonly text: string;
  /** The canonical reference when this segment is one, else null. */
  readonly doc: OpenContextDocHref | null;
}

/** Returns a reference only when the trimmed inline-code value is exactly one. */
export function openContextDocRefFromInlineCode(text: string): OpenContextDocHref | null {
  return parseOpenContextDocHref(text.trim());
}

/** Splits prose while isolating each bare `oc:`/`ocl:` document reference. */
export function openContextDocTextSegments(text: string): ReadonlyArray<OpenContextDocTextSegment> {
  const segments: OpenContextDocTextSegment[] = [];
  const appendPlain = (value: string) => {
    if (!value) return;
    const previous = segments.at(-1);
    if (previous !== undefined && previous.doc === null) {
      segments[segments.length - 1] = { text: previous.text + value, doc: null };
    } else {
      segments.push({ text: value, doc: null });
    }
  };

  const pattern = new RegExp(BARE_DOC_REF_PATTERN.source, BARE_DOC_REF_PATTERN.flags);
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const run = match[2] ?? "";
    const start = match.index + (match[1]?.length ?? 0);
    appendPlain(text.slice(cursor, start));
    const reference = run.replace(TRAILING_PUNCTUATION_PATTERN, "");
    const doc = parseOpenContextDocHref(reference);
    if (doc === null) {
      appendPlain(run);
    } else {
      segments.push({ text: reference, doc });
      appendPlain(run.slice(reference.length));
    }
    cursor = start + run.length;
  }
  appendPlain(text.slice(cursor));
  return segments;
}
