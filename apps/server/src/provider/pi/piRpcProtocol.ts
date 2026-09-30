/**
 * Pi RPC wire helpers.
 *
 * Protocol: strict JSONL over stdin/stdout (`pi --mode rpc --no-session`).
 * Split records only on LF; strip one trailing CR. Never use Node `readline`
 * (splits on U+2028/U+2029 inside JSON strings). Stdout is reserved for
 * protocol records; diagnostics go to stderr.
 *
 * Sources: https://pi.dev/docs/latest/rpc , /rpc-commands , /json ,
 * /rpc-extension-ui , /message-types.
 *
 * @module provider/pi/piRpcProtocol
 */

export type PiPromptDisposition = "started" | "queued" | "handled";

export interface PiCommand {
  readonly id?: string | undefined;
  readonly type: string;
  readonly [key: string]: unknown;
}

export type PiStdoutKind = "response" | "sessionEvent" | "extensionUiRequest" | "unknown";

export interface PiResponseRecord {
  readonly id?: string | undefined;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number | undefined;
  readonly totalTokens: number;
}

export interface PiAssistantMessage {
  readonly role: "assistant";
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string | undefined;
    readonly delta?: string | undefined;
    readonly name?: string | undefined;
    readonly id?: string | undefined;
    readonly arguments?: Record<string, unknown> | undefined;
  }>;
  readonly usage?: PiUsage | undefined;
  readonly stopReason?: string | undefined;
  readonly errorMessage?: string | undefined;
}

let piCommandSequence = 0;

/** Unique per-process command id for correlating Pi `response` records. */
export function nextPiCommandId(prefix = "pi"): string {
  piCommandSequence += 1;
  return `${prefix}-${piCommandSequence}`;
}

/** Encode one stdin record: exactly one JSON object + LF. */
export function encodePiCommand(command: PiCommand): string {
  return `${JSON.stringify(command)}\n`;
}

export function buildPiPromptCommand(input: {
  readonly id?: string | undefined;
  readonly message: string;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
}): PiCommand {
  return {
    ...(input.id ? { id: input.id } : {}),
    type: "prompt",
    message: input.message,
    ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
  };
}

export function buildPiSteerCommand(message: string, id?: string): PiCommand {
  return { ...(id ? { id } : {}), type: "steer", message };
}

export function buildPiFollowUpCommand(message: string, id?: string): PiCommand {
  return { ...(id ? { id } : {}), type: "follow_up", message };
}

export function buildPiGetStateCommand(id?: string): PiCommand {
  return { ...(id ? { id } : {}), type: "get_state" };
}

/**
 * Interruption: `clear_queue` first (drops queued steering/follow-up so
 * `abort` does not continue them — the documented interactive-Esc recipe),
 * then `abort`, which waits for the session to become idle before
 * responding. The runtime still follows with an `agent_settled` timeout +
 * child kill, so interruption holds even if Pi is stuck.
 *
 * Verified against `@earendil-works/pi-coding-agent` 0.87.1
 * (`pi --mode rpc`: `abort` and `clear_queue` both answer `success: true`).
 */
export function buildPiAbortCommand(id?: string): PiCommand {
  return { ...(id ? { id } : {}), type: "abort" };
}

export function buildPiClearQueueCommand(id?: string): PiCommand {
  return { ...(id ? { id } : {}), type: "clear_queue" };
}

export function buildPiExtensionUiResponse(input: {
  readonly id: string;
  readonly payload: Record<string, unknown>;
}): PiCommand {
  return { type: "extension_ui_response", id: input.id, ...input.payload };
}

/** Split a stdout byte/UTF-8 chunk on LF only; callers retain `remainder`. */
export function splitPiJsonl(buffer: string): {
  readonly records: ReadonlyArray<string>;
  readonly remainder: string;
} {
  const records: Array<string> = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === "\n") {
      let line = buffer.slice(start, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length > 0) records.push(line);
      start = index + 1;
    }
  }
  return { records, remainder: buffer.slice(start) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Classify one parsed stdout JSON value without throwing. */
export function classifyPiStdoutRecord(value: unknown): PiStdoutKind {
  if (!isRecord(value) || typeof value.type !== "string") return "unknown";
  if (value.type === "response") return "response";
  if (value.type === "extension_ui_request") return "extensionUiRequest";
  return "sessionEvent";
}

export function parsePiResponseRecord(value: unknown): PiResponseRecord | undefined {
  if (!isRecord(value) || value.type !== "response" || typeof value.command !== "string") {
    return undefined;
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    command: value.command,
    success: value.success === true,
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

export function readPiPromptDisposition(
  response: PiResponseRecord,
): PiPromptDisposition | undefined {
  if (!isRecord(response.data) || typeof response.data.disposition !== "string") return undefined;
  const disposition = response.data.disposition;
  return disposition === "started" || disposition === "queued" || disposition === "handled"
    ? disposition
    : undefined;
}

/**
 * Streaming text for the FT3 transcript: only `text_delta` deltas.
 * `thinking_delta` (reasoning), `toolcall_delta` (serialized tool args),
 * and end snapshots are never transcript text. `text_end`/`message_end`
 * carry authoritative full content, but emitting it would duplicate the
 * already-streamed deltas — the adapter emits `message_end` text only when
 * no `text_delta` arrived for that message.
 */
export function readPiTextDelta(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as {
    assistantMessageEvent?: { type?: string; delta?: unknown } | undefined;
  };
  const event = record.assistantMessageEvent;
  if (event?.type !== "text_delta" || typeof event.delta !== "string") return undefined;
  return event.delta.length > 0 ? event.delta : undefined;
}

export function readPiSessionIdFromState(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct = data.sessionId ?? data.id;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  if (isRecord(data.session) && typeof data.session.id === "string") {
    const nested = data.session.id.trim();
    return nested.length > 0 ? nested : undefined;
  }
  return undefined;
}

/** Append-only text from an assistant message (text blocks only). */
export function piTextFromMessageContent(
  content: PiAssistantMessage["content"] | undefined,
): string {
  if (!content) return "";
  let out = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

/** Tool calls carried inline in an assistant message. */
export function piToolCallsFromMessageContent(
  content: PiAssistantMessage["content"] | undefined,
): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}> {
  if (!content) return [];
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const block of content) {
    if (block.type !== "toolCall" || typeof block.name !== "string") continue;
    calls.push({
      id: typeof block.id === "string" ? block.id : "",
      name: block.name,
      args: block.arguments ?? {},
    });
  }
  return calls;
}

/** Map Pi usage to FT3 token counters. `reasoning` is inside `output`; do not double-add. */
export function piUsageToCounters(usage: PiUsage | undefined):
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number;
      readonly reasoningTokens: number;
    }
  | undefined {
  if (!usage) return undefined;
  const nonNegative = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return {
    inputTokens: nonNegative(usage.input),
    outputTokens: nonNegative(usage.output),
    cachedInputTokens: nonNegative(usage.cacheRead),
    reasoningTokens: usage.reasoning === undefined ? 0 : nonNegative(usage.reasoning),
  };
}

/**
 * Parse `pi --list-models` text (verified against 0.87.1).
 *
 * With a managed agent dir Pi prints a table:
 * `provider  model  context  max-out  thinking  images` + one row per
 * model (`ft3-local  qwen2.5-coder:7b  128K ...`). Rows become qualified
 * `provider/model` slugs, which `--model` accepts. Without configured
 * models Pi prints `No models available...`, which yields `[]`.
 * Bullet (`* slug`) and bare-slug lines are accepted as a fallback.
 */
export function parsePiListModelsOutput(output: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const slugs: Array<string> = [];
  const push = (raw: string): void => {
    const slug = raw.trim();
    if (slug.length === 0 || slug.length > 256 || seen.has(slug)) return;
    if (/^(available|default|models?|provider|you are|not |error|cannot|failed)\b/i.test(slug))
      return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(slug)) return;
    seen.add(slug);
    slugs.push(slug);
  };
  for (const line of output.split(/\r?\n/)) {
    const columns = line
      .split(/\s{2,}|\t/)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (columns.length >= 2) {
      const [provider, model] = columns as [string, string, ...Array<string>];
      if (/^provider$/i.test(provider)) continue;
      if (
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) &&
        model.length > 0 &&
        !model.includes(" ")
      ) {
        push(`${provider}/${model}`);
        continue;
      }
    }
    const bullet = line.match(/^\s*(?:[*-]|\d+[.)])\s+(\S+)(.*)$/);
    if (bullet?.[1]) {
      push(bullet[1]);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.includes(" ")) continue;
    push(trimmed);
  }
  return slugs;
}

/** Terminal completion marker: Pi will not continue automatically after this event. */
export function isPiSettledEvent(value: unknown): boolean {
  return isRecord(value) && value.type === "agent_settled";
}
