/** Last observed Muse subscription windows, scoped to one T3 provider instance. */
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerProviderUsageLimits, type ProviderInstanceId } from "@t3tools/contracts";

import { museUsageToLimits } from "./museUsageLimits.ts";

const UsageLimitsJson = Schema.fromJsonString(ServerProviderUsageLimits);
const decodeUsageLimits = Schema.decodeUnknownEffect(UsageLimitsJson);
const encodeUsageLimits = Schema.encodeEffect(UsageLimitsJson);

/**
 * Returns an opaque path per provider instance. The instance id is hashed so
 * arbitrary ids cannot escape the cache directory or leak into filenames.
 */
export const museUsageCachePath = Effect.fn("MuseUsageCache.path")(function* (
  stateDir: string,
  instanceId: ProviderInstanceId,
): Effect.fn.Return<string, never, Crypto.Crypto | Path.Path> {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const key = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(instanceId))
    .pipe(Effect.map(Encoding.encodeHex), Effect.orDie);
  return path.join(stateDir, "providers", "muse", `${key}.usage.json`);
});

function observationTime(usage: unknown, nowMs: number): string {
  const observedAtMs =
    usage !== null && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)["observedAtMs"]
      : undefined;
  const timestamp =
    typeof observedAtMs === "number" &&
    Number.isFinite(observedAtMs) &&
    observedAtMs > 0 &&
    observedAtMs <= nowMs
      ? observedAtMs
      : nowMs;
  const parsed = DateTime.make(timestamp);
  return Option.isSome(parsed)
    ? DateTime.formatIso(parsed.value)
    : DateTime.formatIso(DateTime.makeUnsafe(nowMs));
}

export interface MuseUsageCache {
  readonly read: Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly observe: (usage: unknown) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export const makeMuseUsageCache = Effect.fn("MuseUsageCache.make")(function* (
  cachePath: string,
): Effect.fn.Return<MuseUsageCache, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gate = yield* Semaphore.make(1);
  let latest: ServerProviderUsageLimits | undefined;

  const read = gate.withPermits(1)(
    Effect.gen(function* () {
      if (latest !== undefined) return latest;

      const decoded = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap(decodeUsageLimits),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.logWarning("Could not read the last Muse usage observation.", {
                cause: error,
              }).pipe(Effect.as(undefined)),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not decode the last Muse usage observation.", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      if (
        decoded === undefined ||
        decoded.unavailable !== undefined ||
        decoded.windows.length === 0
      ) {
        return undefined;
      }

      latest = decoded;
      return decoded;
    }),
  );

  const observe = (usage: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      const limits = museUsageToLimits({
        usage,
        checkedAt: observationTime(usage, yield* Clock.currentTimeMillis),
      });
      if (limits.windows.length === 0) return;

      yield* gate.withPermits(1)(
        Effect.gen(function* () {
          latest = limits;
          yield* encodeUsageLimits(limits).pipe(
            Effect.flatMap((contents) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const targetDirectory = path.dirname(cachePath);
                  yield* fileSystem.makeDirectory(targetDirectory, { recursive: true });
                  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
                    directory: targetDirectory,
                    prefix: `${path.basename(cachePath)}.`,
                  });
                  const temporaryPath = path.join(temporaryDirectory, "contents.tmp");
                  yield* fileSystem.writeFileString(temporaryPath, contents);
                  yield* fileSystem.rename(temporaryPath, cachePath);
                }),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not save the last Muse usage observation.", { cause }),
            ),
          );
        }),
      );
    });

  const clear = gate.withPermits(1)(
    Effect.gen(function* () {
      latest = undefined;
      yield* fileSystem.remove(cachePath).pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.void
            : Effect.logWarning("Could not clear the saved Muse usage observation.", {
                cause: error,
              }),
        ),
      );
    }),
  );

  return { read, observe, clear };
});
