import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type {
  AcpPromptResponse,
  AcpSessionNotification,
  AcpSessionRuntimeService,
  AcpSessionUpdate,
} from "@t3tools/provider-acp-registry/server";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decorateKimiRuntime, kimiEmptyTurnFailureMessage } from "./promptFailure.ts";

const checkedAt = "2026-10-27T04:00:00.000Z";

const limits = (input: {
  readonly usedPercent?: number;
  readonly resetsAt?: string;
  readonly message?: string;
}): ServerProviderUsageLimits => ({
  checkedAt,
  windows:
    input.usedPercent === undefined
      ? []
      : [
          {
            id: "limit_5h",
            kind: "session" as const,
            label: "5-hour",
            usedPercent: input.usedPercent,
            ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
          },
        ],
  ...(input.message === undefined
    ? {}
    : { unavailable: { reason: "probeFailed" as const, message: input.message } }),
});

const promptLimits = (value: ServerProviderUsageLimits) => Effect.succeed(value);

type UpdateHandler = (notification: AcpSessionNotification) => Effect.Effect<void>;

const makeRuntime = (input: {
  readonly stopReason: AcpPromptResponse["stopReason"];
  readonly update?: AcpSessionUpdate;
}): {
  readonly runtime: AcpSessionRuntimeService;
  readonly runPrompt: () => Promise<AcpPromptResponse>;
} => {
  let handler: UpdateHandler | undefined;
  const runtime = {
    handleSessionUpdate: (next: UpdateHandler) =>
      Effect.sync(() => {
        handler = next;
      }),
    prompt: () =>
      Effect.gen(function* () {
        if (input.update !== undefined) {
          const current = handler;
          expect(current).toBeDefined();
          if (current !== undefined) {
            yield* current({ sessionId: "session-1", update: input.update });
          }
        }
        return { stopReason: input.stopReason };
      }),
  } as unknown as AcpSessionRuntimeService;

  return {
    runtime,
    runPrompt: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const decorated = decorateKimiRuntime({
            runtime,
            limits: promptLimits(
              limits({ usedPercent: 100, resetsAt: "2026-10-27T05:30:00.000Z" }),
            ),
            nowMillis: Effect.succeed(Date.parse(checkedAt)),
          });
          yield* decorated.handleSessionUpdate(() => Effect.void);
          return yield* decorated.prompt({ prompt: [] });
        }),
      ),
  };
};

describe("kimiEmptyTurnFailureMessage", () => {
  it("names the exhausted window and its reset delay", () => {
    expect(
      kimiEmptyTurnFailureMessage(
        limits({ usedPercent: 100, resetsAt: "2026-10-27T05:30:00.000Z" }),
        Date.parse(checkedAt),
      ),
    ).toBe("Kimi: 5-hour limit exhausted, resets in 1h 30m.");
  });

  it("omits the delay when the reset time is unknown", () => {
    expect(kimiEmptyTurnFailureMessage(limits({ usedPercent: 100 }), Date.parse(checkedAt))).toBe(
      "Kimi: 5-hour limit exhausted.",
    );
  });

  it("does not claim exhaustion below 100 percent", () => {
    expect(kimiEmptyTurnFailureMessage(limits({ usedPercent: 99 }), Date.parse(checkedAt))).toBe(
      "Kimi: the turn ended without any response.",
    );
  });

  it("keeps a sign-in failure message", () => {
    expect(
      kimiEmptyTurnFailureMessage(
        limits({ message: "Kimi rejected the sign-in token; run `kimi login`." }),
        Date.parse(checkedAt),
      ),
    ).toBe("Kimi rejected the sign-in token; run `kimi login`.");
  });
});

describe("decorateKimiRuntime", () => {
  it("turns an empty end_turn into a quota failure", async () => {
    const { runPrompt } = makeRuntime({ stopReason: "end_turn" });
    const error = await runPrompt().catch((cause: unknown) => cause);

    expect((error as { _tag?: string })._tag).toBe("AcpRequestError");
    expect((error as { errorMessage?: string }).errorMessage).toBe(
      "Kimi: 5-hour limit exhausted, resets in 1h 30m.",
    );
  });

  it("keeps a successful turn that produced text", async () => {
    const { runPrompt } = makeRuntime({
      stopReason: "end_turn",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello" },
      },
    });

    await expect(runPrompt()).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("keeps a successful turn that produced a tool call", async () => {
    const { runPrompt } = makeRuntime({
      stopReason: "end_turn",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
      },
    });

    await expect(runPrompt()).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("does not rewrite cancelled prompts", async () => {
    const { runPrompt } = makeRuntime({ stopReason: "cancelled" });

    await expect(runPrompt()).resolves.toEqual({ stopReason: "cancelled" });
  });
});
