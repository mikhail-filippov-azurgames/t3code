import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
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

import { migrations } from "./migrations.ts";
import { layer as mailRepositoryLayer } from "./repository.ts";
import { layer as mailServiceLayer } from "./service.ts";

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

/** The mail service over an in-memory database, with the given feature, routing and role set. */
export const mailHarness = (
  options: {
    readonly enabled?: boolean;
    readonly routable?: ReadonlyArray<RoutingRoleId>;
    readonly applied?: boolean;
  } = {},
) => {
  const routing = routingFake(options);
  const layer = mailServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(routing.layer, gateLayer(options.enabled ?? true), cryptoLayer)),
    Layer.provideMerge(databaseLayer),
  );
  return { layer, selects: routing.selects };
};
