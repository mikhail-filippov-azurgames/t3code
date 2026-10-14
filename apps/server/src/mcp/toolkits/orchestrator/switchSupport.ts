import {
  isProviderDriverKind,
  type OrchestratorMcpFailure,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type MessageId,
  type OrchestratorMcpRequestedIdentity,
  type ThreadId,
  type OrchestratorMcpFailureCode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";

import type * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";

interface SwitchCommitEntry {
  readonly semaphore: Semaphore.Semaphore;
  holders: number;
}

// Concurrent switches against the same child/thread are serialized by a
// per-task commit lock: the chain head is re-read inside the lock, so a
// racing loser chains after the winner instead of forking the transition
// history with a stale head. The lock is module-scoped so the MCP service
// and per-request UI services share it within this process.
//
// Lifecycle: entries are refcounted and evicted once the last holder
// settles, so the map stays bounded by in-flight switches instead of every
// thread ever switched. Lookup, refcounting, and eviction each run in one
// synchronous block, which is atomic for Effect fibers: a newcomer either
// joins a live entry (and is counted before anyone can evict it) or creates
// a fresh one after eviction (when by definition nobody references the old
// semaphore). The release runs under `ensuring`, so interruption while
// queued or inside the commit still releases the holder.
const switchCommitEntries = new Map<string, SwitchCommitEntry>();

export const withSwitchCommitLock = <A, E, R>(
  taskId: ThreadId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const key = String(taskId);
  let entry = switchCommitEntries.get(key);
  if (entry === undefined) {
    entry = { semaphore: Semaphore.makeUnsafe(1), holders: 0 };
    switchCommitEntries.set(key, entry);
  }
  entry.holders += 1;
  const captured = entry;
  return captured.semaphore.withPermit(effect).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        captured.holders -= 1;
        if (captured.holders === 0 && switchCommitEntries.get(key) === captured) {
          switchCommitEntries.delete(key);
        }
      }),
    ),
  );
};

export const switchCommitLockCount = (): number => switchCommitEntries.size;

export interface SwitchHistoryEntry {
  readonly requested: OrchestratorMcpRequestedIdentity;
  readonly oldProvider: SwitchOldProvider;
  readonly switchedAt: string;
  readonly prevTransition?: string | null;
}

type SwitchOldProvider = Pick<
  OrchestratorMcpRequestedIdentity,
  "providerInstanceId" | "driverKind" | "model"
>;

interface SwitchSupportDependencies {
  readonly activityKind: string;
  readonly activityVersion: number;
  readonly isRequestedIdentity: (value: unknown) => value is OrchestratorMcpRequestedIdentity;
  readonly getProviders: ProviderRegistry.ProviderRegistryShape["getProviders"];
  readonly failure: (code: OrchestratorMcpFailureCode, message: string) => OrchestratorMcpFailure;
  readonly hash: (value: unknown) => string;
  readonly deterministicId: (prefix: string, ...parts: ReadonlyArray<string>) => string;
}

export function makeSwitchSupport(dependencies: SwitchSupportDependencies) {
  const findLastProviderSwitch = (
    thread: OrchestrationThread,
    lineage: { readonly taskId: ThreadId; readonly delegatedMessageId: MessageId },
  ): SwitchHistoryEntry | null => {
    for (let index = thread.activities.length - 1; index >= 0; index--) {
      const activity = thread.activities[index]!;
      if (activity.kind !== dependencies.activityKind || !Predicate.isObject(activity.payload)) {
        continue;
      }
      const payload = activity.payload;
      if (
        payload.version === dependencies.activityVersion &&
        payload.taskId === lineage.taskId &&
        payload.delegatedMessageId === lineage.delegatedMessageId &&
        dependencies.isRequestedIdentity(payload.requested) &&
        typeof payload.switchedAt === "string" &&
        Predicate.isObject(payload.oldProvider)
      ) {
        return payload as unknown as SwitchHistoryEntry;
      }
    }
    return null;
  };

  const findLastOrdinarySwitch = (
    thread: OrchestrationThread,
    taskId: ThreadId,
  ): SwitchHistoryEntry | null => {
    for (let index = thread.activities.length - 1; index >= 0; index--) {
      const activity = thread.activities[index]!;
      if (activity.kind !== dependencies.activityKind || !Predicate.isObject(activity.payload)) {
        continue;
      }
      const payload = activity.payload;
      if (
        payload.version === dependencies.activityVersion &&
        payload.taskId === taskId &&
        (payload.delegatedMessageId === null || payload.delegatedMessageId === undefined) &&
        dependencies.isRequestedIdentity(payload.requested) &&
        typeof payload.switchedAt === "string" &&
        Predicate.isObject(payload.oldProvider)
      ) {
        return payload as unknown as SwitchHistoryEntry;
      }
    }
    return null;
  };

  // Command IDs for a provider switch distinguish the full transition chain,
  // not just the config fingerprint: the fingerprint excludes model and
  // options, so an A→B→A→B cycle or parallel switches to different models
  // would otherwise collide and yield false receipts. Every ID folds in the
  // previous record's transition hash, so each committed switch advances a
  // unique chain even when from/to repeat exactly. All inputs are
  // activity-derived, so an exact retry after a partial crash reuses the same
  // IDs.
  const switchTransitionHash = (
    from: SwitchHistoryEntry["oldProvider"],
    to: OrchestratorMcpRequestedIdentity,
    prev: string | null,
  ): string => dependencies.hash({ from, to, prev });

  const switchTransitionId = (
    prefix: string,
    taskId: ThreadId,
    from: SwitchHistoryEntry["oldProvider"],
    to: OrchestratorMcpRequestedIdentity,
    prev: string | null,
  ): string => dependencies.deterministicId(prefix, taskId, switchTransitionHash(from, to, prev));

  const resolveOrdinaryOldProvider = Effect.fn("OrchestratorMcpService.resolveOrdinaryOldProvider")(
    function* (
      thread: OrchestrationThread,
      session: NonNullable<OrchestrationThreadShell["session"]>,
    ) {
      const providers = yield* dependencies.getProviders;
      const instanceId = session.providerInstanceId ?? thread.modelSelection.instanceId;
      const driverKind =
        providers.find((candidate) => candidate.instanceId === instanceId)?.driver ??
        (isProviderDriverKind(session.providerName) ? session.providerName : undefined);
      if (driverKind === undefined) {
        return yield* dependencies.failure(
          "orchestration_error",
          `Could not determine the thread's current provider for instance ${instanceId}.`,
        );
      }
      return {
        providerInstanceId: instanceId,
        driverKind,
        model: thread.modelSelection.model,
      };
    },
  );

  return {
    findLastProviderSwitch,
    findLastOrdinarySwitch,
    resolveOrdinaryOldProvider,
    switchTransitionHash,
    switchTransitionId,
  };
}
