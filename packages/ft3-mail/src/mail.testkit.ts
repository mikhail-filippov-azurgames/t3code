import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  normalServicePolicyLayer,
  type RoutingResolution,
  type RoutingResolvedCandidate,
  type RoutingResolveInput,
  type RoutingSelectInput,
  type RoutingSelection,
  RoutingPolicyService,
} from "@t3tools/ft3-policies/routing";
import type { RoutingLevel, RoutingRoleId } from "@t3tools/ft3-policies/routingPolicy";
import { FeatureDisabledError, FeatureGate } from "@t3tools/ft3-policies/server";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";

import { MailKindClassifier, type MailClassification } from "./classifier.ts";
import { migrations } from "./migrations.ts";
import {
  MailLaunchError,
  MailParticipantLauncher,
  type MailParticipantLaunchInput,
} from "./participantLauncher.ts";
import { layer as mailRepositoryLayer } from "./repository.ts";
import { layer as mailServiceLayer, MailPolicyEvidence } from "./service.ts";
import { DEFAULT_MAIL_SETTINGS, MailSettingsService } from "./settings.ts";

export const ALL_ROUTING_ROLES: ReadonlyArray<RoutingRoleId> = [
  "architect",
  "implementation",
  "review",
  "test",
  "research",
  "general",
  "planner",
];

export const migrateMail = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "ft3_migrations",
});

export const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(() =>
        globalThis.crypto.subtle
          .digest(algorithm, new Uint8Array(data))
          .then((bytes) => new Uint8Array(bytes)),
      ),
  }),
);

export const databaseLayer = mailRepositoryLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

export const gateLayer = (enabled: boolean) =>
  Layer.succeed(
    FeatureGate,
    FeatureGate.of({
      states: Effect.die("unused"),
      state: () => Effect.die("unused"),
      isEffective: () => Effect.succeed(enabled),
      require: () =>
        enabled
          ? Effect.void
          : Effect.fail(new FeatureDisabledError({ feature: "mail", code: "feature_disabled" })),
    }),
  );

const candidateAt = (level: RoutingLevel): RoutingResolvedCandidate => ({
  alias: "fast",
  provider: { instanceId: "codex", driverKind: "codex" },
  model: "gpt-test",
  level,
  options: [],
});

/** A routing policy where `routable` roles have one candidate and every other role has none. */
export const routingFake = (options: {
  readonly routable?: ReadonlyArray<RoutingRoleId>;
  readonly applied?: boolean;
}) => {
  const routable = options.routable ?? ALL_ROUTING_ROLES;
  const applied = options.applied ?? true;
  const selects: RoutingSelectInput[] = [];
  const resolution = (input: RoutingResolveInput): RoutingResolution => {
    const hasCandidate = routable.includes(input.role);
    return {
      role: input.role,
      level: input.level,
      candidates: hasCandidate ? [candidateAt(input.level)] : [],
      skipped: hasCandidate
        ? []
        : [{ alias: "fast", model: "gpt-test", reason: "unavailable" as const }],
      policy: { revision: 3, sha256: null },
    };
  };
  const layer = Layer.succeed(
    RoutingPolicyService,
    RoutingPolicyService.of({
      resolve: (input) => Effect.succeed(applied ? resolution(input) : null),
      select: (input) =>
        Effect.sync((): RoutingSelection | null => {
          selects.push(input);
          if (!applied) return null;
          const chain = resolution(input);
          return { ...chain, selected: chain.candidates[0] ?? null };
        }),
    }),
  );
  return { layer, selects };
};

/** The applied snapshot is fixed; each card write is recorded for the test to read. */
export const policyEvidenceFake = (knownCards: ReadonlyArray<string> = ["card:one"]) => {
  const cardSnapshots: Array<{ readonly cardId: string; readonly snapshotJson: string }> = [];
  const layer = Layer.succeed(
    MailPolicyEvidence,
    MailPolicyEvidence.of({
      snapshotJson: Effect.succeed('{"revision":3}'),
      cardExists: (cardId) => Effect.succeed(knownCards.includes(cardId)),
      recordCardSnapshot: (input) =>
        Effect.sync(() => {
          cardSnapshots.push(input);
        }),
    }),
  );
  return { layer, cardSnapshots };
};

/** Records launch inputs and starts one thread per member; members in `fail` refuse instead. */
export const launcherFake = (fail: ReadonlySet<string> = new Set()) => {
  const launches: Array<MailParticipantLaunchInput> = [];
  const layer = Layer.succeed(
    MailParticipantLauncher,
    MailParticipantLauncher.of({
      launch: (input) =>
        fail.has(input.memberId)
          ? Effect.fail(new MailLaunchError({ reason: "the orchestrator refused the launch." }))
          : Effect.sync(() => {
              launches.push(input);
              return `thread:participant:${input.memberId}`;
            }),
    }),
  );
  return { layer, launches };
};

/** A classifier fake; the default is the no-op (design §9.4: sender kind stays authoritative). */
export const classifierFake = (classify?: (body: string) => MailClassification | null) => {
  const calls: Array<string> = [];
  const layer = Layer.succeed(
    MailKindClassifier,
    MailKindClassifier.of({
      classify: (input) =>
        Effect.sync(() => {
          calls.push(input.body);
          return classify === undefined ? null : classify(input.body);
        }),
    }),
  );
  return { layer, calls };
};

export const settingsLayer = (overrides: Partial<{ readonly classifierThreshold: number }> = {}) =>
  Layer.succeed(MailSettingsService, { ...DEFAULT_MAIL_SETTINGS, ...overrides });

/** The mail service over an in-memory database, with the given feature, routing and role set. */
export const mailHarness = (
  options: {
    readonly enabled?: boolean;
    readonly routable?: ReadonlyArray<RoutingRoleId>;
    readonly applied?: boolean;
    readonly launchFail?: ReadonlySet<string>;
    readonly classify?: (body: string) => MailClassification | null;
    readonly classifierThreshold?: number;
  } = {},
) => {
  const routing = routingFake(options);
  const evidence = policyEvidenceFake();
  const launcher = launcherFake(options.launchFail);
  const classifier = classifierFake(options.classify);
  const layer = mailServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        routing.layer,
        gateLayer(options.enabled ?? true),
        cryptoLayer,
        evidence.layer,
        launcher.layer,
        classifier.layer,
        normalServicePolicyLayer,
        options.classifierThreshold === undefined
          ? settingsLayer()
          : settingsLayer({ classifierThreshold: options.classifierThreshold }),
      ),
    ),
    Layer.provideMerge(databaseLayer),
  );
  return {
    layer,
    selects: routing.selects,
    cardSnapshots: evidence.cardSnapshots,
    launches: launcher.launches,
    classified: classifier.calls,
  };
};
