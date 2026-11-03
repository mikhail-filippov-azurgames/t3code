/**
 * A strict JSON reader that keeps source positions.
 *
 * The roles and lead-skills manifests are edited by hand, so every diagnostic
 * has to name the line and show its text. `JSON.parse` throws away positions
 * and accepts duplicate keys silently; this reader rejects both.
 */

export type PolicyJsonNode =
  | {
      readonly kind: "object";
      readonly offset: number;
      readonly entries: readonly PolicyJsonProperty[];
    }
  | { readonly kind: "array"; readonly offset: number; readonly items: readonly PolicyJsonNode[] }
  | { readonly kind: "string"; readonly offset: number; readonly value: string }
  | { readonly kind: "number"; readonly offset: number; readonly value: number }
  | { readonly kind: "boolean"; readonly offset: number; readonly value: boolean }
  | { readonly kind: "null"; readonly offset: number };

export interface PolicyJsonProperty {
  readonly key: string;
  /** Offset of the key string. */
  readonly keyOffset: number;
  readonly value: PolicyJsonNode;
}

export interface PolicyJsonFailure {
  readonly ok: false;
  readonly offset: number;
  readonly message: string;
}

export type PolicyJsonResult =
  | { readonly ok: true; readonly value: PolicyJsonNode }
  | PolicyJsonFailure;

/** Maps byte offsets to 1-based lines and exposes the source line text. */
export class SourceLines {
  readonly #source: string;
  readonly #lineStarts: readonly number[];

  constructor(source: string) {
    this.#source = source;
    const starts: number[] = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\n") starts.push(index + 1);
    }
    this.#lineStarts = starts;
  }

  get source(): string {
    return this.#source;
  }

  lineOf(offset: number): number {
    const clamped = Math.max(0, Math.min(offset, this.#source.length));
    let low = 0;
    let high = this.#lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.#lineStarts[middle] ?? 0) <= clamped) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  textOf(offset: number): string {
    const line = this.lineOf(offset) - 1;
    const start = this.#lineStarts[line] ?? 0;
    const nextStart = this.#lineStarts[line + 1] ?? this.#source.length + 1;
    const end = Math.min(this.#source.length, Math.max(start, nextStart - 1));
    return this.#source.slice(start, end).replace(/\r$/, "").trim();
  }
}

class JsonReader {
  readonly #lines: SourceLines;
  readonly #text: string;
  #cursor = 0;

  constructor(text: string) {
    this.#lines = new SourceLines(text);
    this.#text = text;
  }

  get lines(): SourceLines {
    return this.#lines;
  }

  fail(offset: number, message: string): PolicyJsonFailure {
    return { ok: false, offset, message };
  }

  #peek(): string | undefined {
    return this.#text[this.#cursor];
  }

  #skipWhitespace(): void {
    while (this.#cursor < this.#text.length) {
      const character = this.#text[this.#cursor];
      if (character === " " || character === "\t" || character === "\n" || character === "\r") {
        this.#cursor += 1;
      } else {
        return;
      }
    }
  }

  #readString(): PolicyJsonResult {
    const start = this.#cursor;
    this.#cursor += 1;
    let value = "";
    while (this.#cursor < this.#text.length) {
      const character = this.#text[this.#cursor];
      if (character === '"') {
        this.#cursor += 1;
        return { ok: true, value: { kind: "string", offset: start, value } };
      }
      if (character === "\\") {
        const escape = this.#text[this.#cursor + 1];
        this.#cursor += 2;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            value += escape;
            break;
          case "b":
            value += "\b";
            break;
          case "f":
            value += "\f";
            break;
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case "u": {
            const digits = this.#text.slice(this.#cursor, this.#cursor + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
              return this.fail(start, "invalid unicode escape in the string");
            }
            value += String.fromCharCode(Number.parseInt(digits, 16));
            this.#cursor += 4;
            break;
          }
          default:
            return this.fail(start, "invalid escape in the string");
        }
        continue;
      }
      if (character === undefined || character === "\n" || character === "\r") {
        return this.fail(start, "unterminated string");
      }
      value += character;
      this.#cursor += 1;
    }
    return this.fail(start, "unterminated string");
  }

  #readNumber(start: number): PolicyJsonResult {
    const pattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
    const match = pattern.exec(this.#text.slice(start));
    if (match === null) return this.fail(start, "expected a number");
    this.#cursor = start + match[0].length;
    return { ok: true, value: { kind: "number", offset: start, value: Number(match[0]) } };
  }

  #readLiteral(literal: string, node: PolicyJsonNode): PolicyJsonResult {
    if (this.#text.slice(this.#cursor, this.#cursor + literal.length) !== literal) {
      return this.fail(this.#cursor, `expected "${literal}"`);
    }
    this.#cursor += literal.length;
    return { ok: true, value: node };
  }

  readValue(): PolicyJsonResult {
    this.#skipWhitespace();
    const start = this.#cursor;
    const character = this.#peek();
    if (character === undefined) return this.fail(start, "expected a value");
    switch (character) {
      case "{": {
        this.#cursor += 1;
        const entries: PolicyJsonProperty[] = [];
        this.#skipWhitespace();
        if (this.#peek() === "}") {
          this.#cursor += 1;
          return { ok: true, value: { kind: "object", offset: start, entries } };
        }
        for (;;) {
          this.#skipWhitespace();
          const keyOffset = this.#cursor;
          if (this.#peek() !== '"') return this.fail(keyOffset, "expected a property name");
          const key = this.#readString();
          if (!key.ok) return key;
          const keyNode = key.value;
          if (keyNode.kind !== "string") return this.fail(keyOffset, "expected a property name");
          const keyName = keyNode.value;
          this.#skipWhitespace();
          if (this.#peek() !== ":")
            return this.fail(this.#cursor, 'expected ":" after the property name');
          this.#cursor += 1;
          if (entries.some((entry) => entry.key === keyName)) {
            return this.fail(keyOffset, `duplicate property "${keyName}"`);
          }
          const value = this.readValue();
          if (!value.ok) return value;
          entries.push({ key: keyName, keyOffset, value: value.value });
          this.#skipWhitespace();
          const separator = this.#peek();
          if (separator === ",") {
            this.#cursor += 1;
            continue;
          }
          if (separator === "}") {
            this.#cursor += 1;
            return { ok: true, value: { kind: "object", offset: start, entries } };
          }
          return this.fail(this.#cursor, 'expected "," or "}"');
        }
      }
      case "[": {
        this.#cursor += 1;
        const items: PolicyJsonNode[] = [];
        this.#skipWhitespace();
        if (this.#peek() === "]") {
          this.#cursor += 1;
          return { ok: true, value: { kind: "array", offset: start, items } };
        }
        for (;;) {
          const item = this.readValue();
          if (!item.ok) return item;
          items.push(item.value);
          this.#skipWhitespace();
          const separator = this.#peek();
          if (separator === ",") {
            this.#cursor += 1;
            continue;
          }
          if (separator === "]") {
            this.#cursor += 1;
            return { ok: true, value: { kind: "array", offset: start, items } };
          }
          return this.fail(this.#cursor, 'expected "," or "]"');
        }
      }
      case '"': {
        return this.#readString();
      }
      case "t":
        return this.#readLiteral("true", { kind: "boolean", offset: start, value: true });
      case "f":
        return this.#readLiteral("false", { kind: "boolean", offset: start, value: false });
      case "n":
        return this.#readLiteral("null", { kind: "null", offset: start });
      default:
        if (character === "-" || (character >= "0" && character <= "9")) {
          return this.#readNumber(start);
        }
        return this.fail(start, `unexpected character "${character}"`);
    }
  }

  end(): PolicyJsonFailure | { readonly ok: true } {
    this.#skipWhitespace();
    if (this.#cursor !== this.#text.length) {
      return this.fail(this.#cursor, "unexpected text after the JSON value");
    }
    return { ok: true };
  }
}

/** Reads one strict JSON value: no comments, trailing commas or duplicate keys. */
export function parsePolicyJson(source: string): PolicyJsonResult {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const reader = new JsonReader(text);
  const value = reader.readValue();
  if (!value.ok) return value;
  const end = reader.end();
  if (!end.ok) return end;
  return { ok: true, value: value.value };
}

/** A short human description of a value, used as the `got "<actual>"` of a diagnostic. */
export function describePolicyJsonValue(node: PolicyJsonNode): string {
  switch (node.kind) {
    case "string":
      return node.value;
    case "number":
      return String(node.value);
    case "boolean":
      return String(node.value);
    case "null":
      return "null";
    case "array":
      return "an array";
    case "object":
      return "an object";
  }
}

/** The property with this key, or undefined; the reader already rejected duplicates. */
export function policyJsonProperty(
  node: PolicyJsonNode,
  key: string,
): PolicyJsonProperty | undefined {
  if (node.kind !== "object") return undefined;
  return node.entries.find((entry) => entry.key === key);
}
