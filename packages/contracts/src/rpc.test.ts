import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { WsSubscribeServerConfigRpc } from "./rpc.ts";
import {
  ORCHESTRATION_DELEGATED_TASK_SUMMARY_PAGE_MAX,
  ORCHESTRATION_WS_METHODS,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("delegated task summary history RPC contract", () => {
  it("accepts a scoped keyset cursor and returns distinct summary/current state", () => {
    expect(ORCHESTRATION_WS_METHODS.listDelegatedTaskSummaryHistory).toBe(
      "orchestration.listDelegatedTaskSummaryHistory",
    );
    const input = Schema.decodeUnknownSync(
      OrchestrationRpcSchemas.listDelegatedTaskSummaryHistory.input,
    )({
      parentThreadId: "parent-1",
      limit: 25,
      cursor: {
        completedAt: "2026-09-20T10:00:00.000Z",
        childThreadId: "child-1",
        sourceTurnId: "turn-1",
      },
    });
    expect(input.cursor?.sourceTurnId).toBe("turn-1");
    const page = Schema.decodeUnknownSync(
      OrchestrationRpcSchemas.listDelegatedTaskSummaryHistory.output,
    )({
      records: [
        {
          childThreadId: "child-1",
          sourceTurnId: "turn-1",
          completedAt: "2026-09-20T10:00:00.000Z",
          summaryText: "Completed the implementation.",
          summaryState: "ready",
          summaryWatermark: 12,
          currentTurnId: "turn-2",
          currentTurnState: "running",
          currentWatermark: 13,
          executorRole: "implementation",
          stale: true,
        },
      ],
      nextCursor: null,
    });
    const record = page.records[0]!;
    expect(record).toMatchObject({
      summaryState: "ready",
      currentTurnState: "running",
      stale: true,
    });
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationRpcSchemas.listDelegatedTaskSummaryHistory.output)({
        records: Array.from(
          { length: ORCHESTRATION_DELEGATED_TASK_SUMMARY_PAGE_MAX + 1 },
          () => record,
        ),
        nextCursor: null,
      }),
    ).toThrow();
  });
});
