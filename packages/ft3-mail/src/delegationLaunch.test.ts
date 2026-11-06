import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { DelegationLaunchPolicy } from "@t3tools/ft3-delegation/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import { mailDelegationLaunchLayer, mailMemberAliasHint } from "./delegationLaunch.ts";
import { gateLayer } from "./mail.testkit.ts";

const launchOn = mailDelegationLaunchLayer.pipe(Layer.provide(gateLayer(true)));
const launchOff = mailDelegationLaunchLayer.pipe(Layer.provide(gateLayer(false)));

const launchOf = (role: string | undefined, callerThreadId?: string) =>
  Effect.gen(function* () {
    const policy = yield* DelegationLaunchPolicy;
    return yield* policy.launchFor(role, callerThreadId);
  });

it.effect("launches a delegated role as a mail participant only while mail is on", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* launchOf("design").pipe(Effect.provide(launchOn)), {
      _tag: "mail_required",
      role: "design",
    });
    assert.deepStrictEqual(yield* launchOf(undefined).pipe(Effect.provide(launchOn)), {
      _tag: "mail_required",
      role: "general",
    });
    assert.deepStrictEqual(yield* launchOf("design").pipe(Effect.provide(launchOff)), {
      _tag: "direct",
    });
  }),
);

it.effect("uses the caller thread project for delegated launches", () => {
  const disabled = ThreadId.make("thread:delegation-disabled");
  const enabled = ThreadId.make("thread:delegation-enabled");
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        threadId === disabled
          ? { ...liveThreadShell(threadId), projectId: ProjectId.make("project:off") }
          : threadId === enabled
            ? { ...liveThreadShell(threadId), projectId: ProjectId.make("project:on") }
            : null,
      ),
  });
  const layer = mailDelegationLaunchLayer.pipe(
    Layer.provideMerge(gateLayer(true, true, { "project:off": { mail: false } })),
    Layer.provideMerge(threads),
  );
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* launchOf("design", disabled).pipe(Effect.provide(layer)), {
      _tag: "direct",
    });
    assert.deepStrictEqual(yield* launchOf("design", enabled).pipe(Effect.provide(layer)), {
      _tag: "mail_required",
      role: "design",
    });
  });
});

it.effect("names the mail alias of a delegated role id", () =>
  Effect.sync(() => {
    assert.equal(mailMemberAliasHint("review-common"), 'role: "review", specialization: "common"');
    assert.equal(
      mailMemberAliasHint("architect-data"),
      'role: "architect", specialization: "data"',
    );
    assert.equal(mailMemberAliasHint("implementation"), 'role: "implementation"');
    assert.equal(mailMemberAliasHint("review"), 'role: "review"');
  }),
);
