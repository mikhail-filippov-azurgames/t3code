import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  BUNDLED_PI_UPDATE_MESSAGE,
  disableBundledPiUpdate,
  makeBundledPiMaintenanceCapabilities,
  makeBundledPiSnapshot,
} from "./bundledPiMaintenance.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const snapshotWithAdvisory = {
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "0.87.1",
    latestVersion: "0.88.0",
    updateCommand: "pi.cmd update --self",
    canUpdate: true,
    canInstallVersion: true,
    checkedAt: null,
    message: null,
  },
} as ServerProvider;

const upstreamCapabilities = makeBundledPiMaintenanceCapabilities({
  provider: PROVIDER,
  packageName: "@earendil-works/pi-coding-agent",
});

it("replaces the bundled updater with a reason and no command", () => {
  const next = disableBundledPiUpdate(snapshotWithAdvisory);

  assert.isFalse(next.versionAdvisory?.canUpdate ?? true);
  assert.isFalse(next.versionAdvisory?.canInstallVersion ?? true);
  assert.isNull(next.versionAdvisory?.updateCommand);
  assert.equal(next.versionAdvisory?.message, BUNDLED_PI_UPDATE_MESSAGE);
});

it.effect("wraps every managed snapshot view", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(snapshotWithAdvisory);
    const base: ManagedServerProvider = {
      resolveMaintenance: () => Effect.succeed(upstreamCapabilities),
      getSnapshot: Ref.get(state),
      refresh: Ref.get(state),
      applyUsageLimits: () => Effect.void,
      streamChanges: Stream.make(snapshotWithAdvisory),
    };
    const capabilities = makeBundledPiMaintenanceCapabilities({
      provider: PROVIDER,
      packageName: "@earendil-works/pi-coding-agent",
      installPath: "C:/pi/dist/bundle/cli.js",
    });
    const wrapped = makeBundledPiSnapshot({ snapshot: base, capabilities });

    const maintenance = yield* wrapped.resolveMaintenance();
    const current = yield* wrapped.getSnapshot;
    const changes = yield* Stream.runCollect(wrapped.streamChanges);

    assert.isNull(maintenance.update);
    assert.isFalse(current.versionAdvisory?.canUpdate ?? true);
    assert.isTrue(Array.from(changes).every((item) => item.versionAdvisory?.canUpdate === false));
  }),
);
