import * as Predicate from "effect/Predicate";

const DELEGATION_COMPLETED_ACTIVITY = "delegation.completed";
const DELEGATION_WAKE_DELIVERED_ACTIVITY = "delegation.wake-delivered";
const PROVIDER_TURN_START_FAILED_ACTIVITY = "provider.turn.start.failed";
const DELEGATION_WAKE_MESSAGE_PREFIX = "delegation-wake:";
const DELEGATION_WAKE_TURN_PREFIX = "delegation-wake-turn:";
const DELEGATION_WAKE_DRAIN_PREFIX = "delegation-wake-drain:";

export const delegatedChildTurnKey = (childThreadId: string, turnId: string): string =>
  `${childThreadId.length}:${childThreadId}${turnId.length}:${turnId}`;

type CompletedPair = {
  readonly childThreadId: string;
  readonly turnId: string;
  readonly key: string;
};

function completedPairs(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyArray<CompletedPair> {
  const pairs = new Map<string, CompletedPair>();
  for (const activity of activities) {
    if (activity.kind !== DELEGATION_COMPLETED_ACTIVITY || !Predicate.isObject(activity.payload)) {
      continue;
    }
    const childThreadId = activity.payload.childThreadId;
    const turnId = activity.payload.delegatedTurnId;
    if (typeof childThreadId !== "string" || typeof turnId !== "string") continue;
    const key = delegatedChildTurnKey(childThreadId, turnId);
    pairs.set(key, { childThreadId, turnId, key });
  }
  return [...pairs.values()];
}

function legacyAliasesForPair(input: { readonly threadId: string; readonly pair: CompletedPair }) {
  const { pair } = input;
  return [
    `${DELEGATION_WAKE_MESSAGE_PREFIX}${pair.turnId}`,
    `${DELEGATION_WAKE_TURN_PREFIX}${pair.childThreadId}:${pair.turnId}`,
    `${DELEGATION_WAKE_TURN_PREFIX}${pair.turnId}`,
    `${DELEGATION_WAKE_DRAIN_PREFIX}${input.threadId}:${pair.turnId}`,
  ];
}

function ambiguousLegacyAliases(input: {
  readonly threadId: string;
  readonly pairs: ReadonlyArray<CompletedPair>;
}): ReadonlySet<string> {
  const owners = new Map<string, Set<string>>();
  const addOwner = (alias: string, pairKey: string) => {
    const pairKeys = owners.get(alias) ?? new Set<string>();
    pairKeys.add(pairKey);
    owners.set(alias, pairKeys);
  };

  for (const pair of input.pairs) {
    for (const alias of legacyAliasesForPair({ threadId: input.threadId, pair })) {
      addOwner(alias, pair.key);
    }
  }

  return new Set([...owners].flatMap(([alias, pairKeys]) => (pairKeys.size > 1 ? [alias] : [])));
}

export function unambiguousLegacyDelegationWakeIds(input: {
  readonly threadId: string;
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): ReadonlySet<string> {
  const pairs = completedPairs(input.activities);
  const ambiguousAliases = ambiguousLegacyAliases({ threadId: input.threadId, pairs });
  return new Set(
    pairs.flatMap((pair) =>
      legacyAliasesForPair({ threadId: input.threadId, pair }).filter(
        (alias) => !ambiguousAliases.has(alias),
      ),
    ),
  );
}

function failedTurnStartMessageIds(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlySet<string> {
  const messageIds = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== PROVIDER_TURN_START_FAILED_ACTIVITY ||
      !Predicate.isObject(activity.payload) ||
      typeof activity.payload.requestId !== "string"
    ) {
      continue;
    }
    messageIds.add(activity.payload.requestId);
  }
  return messageIds;
}

export function handledDelegationWakeMessageIds(input: {
  readonly threadId: string;
  readonly currentMessageId?: string;
  readonly messageIds: ReadonlySet<string>;
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): ReadonlySet<string> {
  const deliveredMessageIds = new Set<string>();
  for (const activity of input.activities) {
    if (
      activity.kind !== DELEGATION_WAKE_DELIVERED_ACTIVITY ||
      !Predicate.isObject(activity.payload) ||
      !Array.isArray(activity.payload.wakeMessageIds)
    ) {
      continue;
    }
    for (const messageId of activity.payload.wakeMessageIds) {
      if (typeof messageId === "string") deliveredMessageIds.add(messageId);
    }
  }

  const pairs = completedPairs(input.activities);
  const unambiguousLegacyAliases = unambiguousLegacyDelegationWakeIds({
    threadId: input.threadId,
    activities: input.activities,
  });
  const failedStartMessageIds = failedTurnStartMessageIds(input.activities);
  const handledMessageIds = new Set(deliveredMessageIds);

  for (const pair of pairs) {
    const legacyWakeMessageId = `${DELEGATION_WAKE_MESSAGE_PREFIX}${pair.turnId}`;
    const legacyDirectTurnMessageId = `${DELEGATION_WAKE_TURN_PREFIX}${pair.childThreadId}:${pair.turnId}`;
    const legacyTurnMessageId = `${DELEGATION_WAKE_TURN_PREFIX}${pair.turnId}`;
    const legacyDrainTurnMessageId = `${DELEGATION_WAKE_DRAIN_PREFIX}${input.threadId}:${pair.turnId}`;
    const wakeMessageIds = [
      `${DELEGATION_WAKE_MESSAGE_PREFIX}${pair.key}`,
      ...(unambiguousLegacyAliases.has(legacyWakeMessageId) ? [legacyWakeMessageId] : []),
    ];
    const turnAnchorIds = [
      `${DELEGATION_WAKE_TURN_PREFIX}${pair.key}`,
      `${DELEGATION_WAKE_DRAIN_PREFIX}${input.threadId}:${pair.key}`,
      ...(unambiguousLegacyAliases.has(legacyDirectTurnMessageId)
        ? [legacyDirectTurnMessageId]
        : []),
      ...(unambiguousLegacyAliases.has(legacyTurnMessageId) ? [legacyTurnMessageId] : []),
      ...(unambiguousLegacyAliases.has(legacyDrainTurnMessageId) ? [legacyDrainTurnMessageId] : []),
    ];
    const delivered = wakeMessageIds.some((messageId) => deliveredMessageIds.has(messageId));
    const anchoredByAnotherTurn = turnAnchorIds.some(
      (messageId) =>
        messageId !== input.currentMessageId &&
        input.messageIds.has(messageId) &&
        !failedStartMessageIds.has(messageId),
    );
    if (delivered || anchoredByAnotherTurn) {
      for (const messageId of wakeMessageIds) handledMessageIds.add(messageId);
    }
  }
  return handledMessageIds;
}
