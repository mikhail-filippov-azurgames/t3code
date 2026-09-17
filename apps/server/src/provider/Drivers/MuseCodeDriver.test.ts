import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProviderDriverError } from "../Errors.ts";
import { assertMuseSubscriptionEnv, MuseCodeDriver } from "./MuseCodeDriver.ts";

describe("MuseCodeDriver", () => {
  it("advertises a distinct subscription-only driver kind", () => {
    expect(String(MuseCodeDriver.driverKind)).toBe("museCode");
    expect(MuseCodeDriver.metadata.displayName).toBe("Muse Code");
    expect(MuseCodeDriver.defaultConfig().enabled).toBe(false);
  });
});

describe("assertMuseSubscriptionEnv", () => {
  it.effect("passes a key-free environment", () =>
    Effect.gen(function* () {
      yield* assertMuseSubscriptionEnv({ instanceId: "muse", stripped: [] });
    }),
  );

  it.effect("fails closed when API keys were stripped", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        assertMuseSubscriptionEnv({ instanceId: "muse", stripped: ["META_API_KEY"] }),
      );

      expect(failure).toBeInstanceOf(ProviderDriverError);
      expect(failure.detail).toContain("META_API_KEY");
    }),
  );
});
