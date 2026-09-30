import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildPiAbortCommand,
  buildPiClearQueueCommand,
  buildPiPromptCommand,
  classifyPiStdoutRecord,
  encodePiCommand,
  isPiSettledEvent,
  parsePiListModelsOutput,
  parsePiResponseRecord,
  piTextFromMessageContent,
  piToolCallsFromMessageContent,
  piUsageToCounters,
  readPiPromptDisposition,
  readPiSessionIdFromState,
  readPiTextDelta,
  splitPiJsonl,
} from "./piRpcProtocol.ts";

describe("pi RPC framing", () => {
  it("encodes one JSON object per LF and splits only on LF", () => {
    const line = encodePiCommand(buildPiPromptCommand({ message: "hi sep" }));
    NodeAssert.ok(line.endsWith("\n") && !line.endsWith("\n\n"));
    // U+2028 inside the payload must not split records.
    const { records, remainder } = splitPiJsonl(`${line}partial`);
    NodeAssert.equal(records.length, 1);
    NodeAssert.equal(remainder, "partial");
    NodeAssert.deepEqual(splitPiJsonl("a\r\n\nb\n"), { records: ["a", "b"], remainder: "" });
  });

  it("classifies responses, session events, and extension UI requests", () => {
    NodeAssert.equal(classifyPiStdoutRecord({ type: "response", command: "prompt" }), "response");
    NodeAssert.equal(
      classifyPiStdoutRecord({ type: "extension_ui_request", method: "confirm" }),
      "extensionUiRequest",
    );
    NodeAssert.equal(classifyPiStdoutRecord({ type: "agent_settled" }), "sessionEvent");
    NodeAssert.equal(classifyPiStdoutRecord({}), "unknown");
    NodeAssert.equal(isPiSettledEvent({ type: "agent_settled" }), true);
    NodeAssert.equal(isPiSettledEvent({ type: "agent_end" }), false);
  });

  it("reads prompt disposition and session id without throwing", () => {
    const response = parsePiResponseRecord({
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    NodeAssert.ok(response);
    NodeAssert.equal(readPiPromptDisposition(response!), "started");
    NodeAssert.equal(readPiSessionIdFromState({ sessionId: " abc " }), "abc");
    NodeAssert.equal(readPiSessionIdFromState({ session: { id: "s1" } }), "s1");
    NodeAssert.equal(readPiSessionIdFromState({}), undefined);
  });

  it("interrupts with clear_queue before abort (documented Esc recipe)", () => {
    NodeAssert.equal(buildPiClearQueueCommand().type, "clear_queue");
    NodeAssert.equal(buildPiAbortCommand().type, "abort");
  });

  it("maps only text_delta to transcript text", () => {
    NodeAssert.equal(
      readPiTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
      }),
      "Hello ",
    );
    NodeAssert.equal(
      readPiTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
      }),
      undefined,
    );
    NodeAssert.equal(
      readPiTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' },
      }),
      undefined,
    );
    NodeAssert.equal(
      readPiTextDelta({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: { type: "text", text: "Hello" },
        },
      }),
      undefined,
    );
    NodeAssert.equal(readPiTextDelta({ type: "message_update" }), undefined);
    NodeAssert.equal(readPiTextDelta({}), undefined);
  });

  it("extracts text, tool calls, and usage without double-counting reasoning", () => {
    NodeAssert.equal(
      piTextFromMessageContent([
        { type: "text", text: "hello " },
        { type: "thinking", text: "hidden" },
      ]),
      "hello ",
    );
    NodeAssert.deepEqual(
      piToolCallsFromMessageContent([
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
        { type: "text", text: "x" },
      ]),
      [{ id: "t1", name: "read", args: { path: "a" } }],
    );
    NodeAssert.deepEqual(
      piUsageToCounters({
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        totalTokens: 15,
      }),
      { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 3 },
    );
  });

  it("parses list-models output conservatively", () => {
    NodeAssert.deepEqual(
      parsePiListModelsOutput(
        "Available models:\n* qwen2.5-coder:7b (default)\n- ft3-local/extra\n",
      ),
      ["qwen2.5-coder:7b", "ft3-local/extra"],
    );
    NodeAssert.deepEqual(parsePiListModelsOutput("You are logged in\n"), []);
    NodeAssert.deepEqual(
      parsePiListModelsOutput("No models available. Use /login to log in.\n"),
      [],
    );
  });

  it("parses the list-models table into qualified slugs", () => {
    NodeAssert.deepEqual(
      parsePiListModelsOutput(
        "provider   model             context  max-out  thinking  images\nft3-local  qwen2.5-coder:7b  128K     16.4K    no        no\n",
      ),
      ["ft3-local/qwen2.5-coder:7b"],
    );
  });
});
