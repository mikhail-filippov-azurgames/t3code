import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { FeatureId } from "@t3tools/ft3-policies/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as BoardWakeService from "./BoardWakeService.ts";

const leadId = ThreadId.make("board:parent");
const otherLeadId = ThreadId.make("board:other-parent");

interface Sent {
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
}

const harness = <A>(
  features: Readonly<Record<string, boolean>>,
  action: (
    service: BoardWakeService.BoardWakeService["Service"],
  ) => Effect.Effect<A, BoardWakeService.BoardWakeFailure>,
  projectOverrides: Readonly<Record<string, Partial<Record<FeatureId, boolean>>>> = {},
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<Sent>>([]);
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => {
        const projectId =
          threadId === leadId
            ? "project:board-off"
            : threadId === otherLeadId
              ? "project:board-on"
              : undefined;
        return Effect.succeed(
          projectId === undefined
            ? null
            : { ...liveThreadShell(threadId), projectId: ProjectId.make(projectId) },
        );
      },
      dispatch: (command) =>
        command.type === "message.dispatch"
          ? Ref.update(sent, (entries) => [
              ...entries,
              {
                commandId: String(command.commandId),
                messageId: String(command.messageId),
                text: command.text,
              },
            ]).pipe(Effect.as({} as never))
          : Effect.die("unexpected command"),
    });
    const layer = BoardWakeService.layer.pipe(
      Layer.provide(threads),
      Layer.provide(
        ServerSettings.layerTest({
          ft3: { policies: { features } },
          projectSettingsOverrides: Object.fromEntries(
            Object.entries(projectOverrides).map(([projectId, ft3FeatureToggles]) => [
              ProjectId.make(projectId),
              { ft3FeatureToggles },
            ]),
          ),
        }),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    );
    return yield* Effect.gen(function* () {
      const service = yield* BoardWakeService.BoardWakeService;
      const outcome = yield* action(service);
      return { outcome, sent: yield* Ref.get(sent) };
    }).pipe(Effect.provide(layer));
  });

describe("ft3 board wake service", () => {
  it.effect("wakes the lead for every existing reason under its own message id", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [BoardWakeService.BoardWakeReason, string, string]> = [
        ["marked", String(leadId), "This thread was marked a board lead by a human."],
        ["brief", `${leadId}:nonce-1`, "The board brief was re-delivered by a human."],
        ["started", "card:one", 'Card "Mail: address matrix" was started by a human.'],
        ["executor", `42:${leadId}`, "Executor finished: completed."],
        ["orphaned", `card:one:board:child:2026-10-26T00:00:00.000Z`, "Executor lost its session."],
      ];
      for (const [reason, key, context] of cases) {
        const result = yield* harness({}, (service) =>
          service.wake({ reason, key, threadId: leadId, context }),
        );
        assert.equal(result.outcome, "sent");
        assert.equal(result.sent.length, 1);
        const message = result.sent[0]!;
        assert.equal(message.commandId, BoardWakeService.boardWakeMessageId(reason, key));
        assert.equal(message.messageId, message.commandId);
        assert.include(message.text, context);
        if (reason === "marked" || reason === "brief") {
          assert.isTrue(message.text.startsWith("You are the lead for this board thread."));
        } else {
          assert.notInclude(message.text, "You are the lead for this board thread.");
          assert.isTrue(message.text.endsWith("Rules: see your lead brief."));
        }
      }
    }),
  );

  it.effect("sends nothing while the board feature is off", () =>
    Effect.gen(function* () {
      const result = yield* harness({ board: false }, (service) =>
        service.wake({
          reason: "marked",
          key: String(leadId),
          threadId: leadId,
          context: "This thread was marked a board lead by a human.",
        }),
      );
      assert.equal(result.outcome, "skipped");
      assert.deepStrictEqual(result.sent, []);
    }),
  );

  it.effect("uses the lead project for wakes and the environment for unknown threads", () =>
    Effect.gen(function* () {
      const disabled = yield* harness(
        { board: true },
        (service) =>
          service.wake({
            reason: "marked",
            key: String(leadId),
            threadId: leadId,
            context: "Board disabled in this project.",
          }),
        { "project:board-off": { board: false } },
      );
      assert.equal(disabled.outcome, "skipped");
      assert.deepStrictEqual(disabled.sent, []);

      const enabled = yield* harness({ board: true }, (service) =>
        service.wake({
          reason: "marked",
          key: String(otherLeadId),
          threadId: otherLeadId,
          context: "Board enabled in this project.",
        }),
      );
      assert.equal(enabled.outcome, "sent");
      assert.lengthOf(enabled.sent, 1);

      const unresolved = yield* harness({ board: true }, (service) =>
        service.wake({
          reason: "marked",
          key: "board:unresolved",
          threadId: ThreadId.make("board:unresolved"),
          context: "Uses the environment setting.",
        }),
      );
      assert.equal(unresolved.outcome, "sent");
      assert.lengthOf(unresolved.sent, 1);
    }),
  );

  it.effect("reuses one message id for a repeated wake key", () =>
    Effect.gen(function* () {
      const input: BoardWakeService.BoardWakeInput = {
        reason: "executor",
        key: `42:${leadId}`,
        threadId: leadId,
        context: "Executor finished: failed.",
      };
      const result = yield* harness({}, (service) =>
        Effect.gen(function* () {
          const first = yield* service.wake(input);
          const second = yield* service.wake(input);
          return { first, second };
        }),
      );
      assert.deepStrictEqual(result.outcome, { first: "sent", second: "sent" });
      assert.deepStrictEqual(
        result.sent.map((message) => message.messageId),
        ["ft3:board:wake:42:board:parent", "ft3:board:wake:42:board:parent"],
      );
    }),
  );
});

describe("ft3 board wake message ids", () => {
  it("round-trips every reason and rejects a foreign namespace", () => {
    for (const reason of BoardWakeService.BOARD_WAKE_REASONS) {
      const id = BoardWakeService.boardWakeMessageId(reason, "key:part");
      assert.deepStrictEqual(BoardWakeService.parseBoardWakeMessageId(id), {
        reason,
        key: "key:part",
      });
    }
    assert.isNull(BoardWakeService.parseBoardWakeMessageId("ft3:board:unknown:key"));
  });
});
