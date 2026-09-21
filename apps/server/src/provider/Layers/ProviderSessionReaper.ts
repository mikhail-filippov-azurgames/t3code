import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const IDLE_ENV = "T3CODE_PROVIDER_SESSION_IDLE_MS";
const INTERVAL_ENV = "T3CODE_PROVIDER_SESSION_REAPER_INTERVAL_MS";

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface ProviderSessionReaperEnv {
  readonly T3CODE_PROVIDER_SESSION_IDLE_MS?: string | undefined;
  readonly T3CODE_PROVIDER_SESSION_REAPER_INTERVAL_MS?: string | undefined;
}

export interface ResolvedProviderSessionReaperOptions {
  readonly inactivityThresholdMs: number;
  readonly sweepIntervalMs: number;
  readonly invalidEnv: ReadonlyArray<{ readonly name: string; readonly raw: string }>;
}

type ParsedEnvMs =
  | { readonly _tag: "unset" }
  | { readonly _tag: "valid"; readonly value: number }
  | { readonly _tag: "invalid"; readonly raw: string };

const parsePositiveMs = (raw: string | undefined): ParsedEnvMs => {
  if (raw === undefined) {
    return { _tag: "unset" };
  }
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return { _tag: "invalid", raw };
  }
  return { _tag: "valid", value: parsed };
};

// Precedence: explicit options (tests, programmatic callers) > env > default.
// Invalid or non-positive env values are ignored so a typo cannot disable the
// reaper; the caller logs them.
export const resolveProviderSessionReaperOptions = (
  options?: ProviderSessionReaperLiveOptions,
  env?: ProviderSessionReaperEnv,
): ResolvedProviderSessionReaperOptions => {
  const idle = parsePositiveMs(env?.[IDLE_ENV]);
  const interval = parsePositiveMs(env?.[INTERVAL_ENV]);

  return {
    inactivityThresholdMs:
      options?.inactivityThresholdMs !== undefined
        ? Math.max(1, options.inactivityThresholdMs)
        : idle._tag === "valid"
          ? idle.value
          : DEFAULT_INACTIVITY_THRESHOLD_MS,
    sweepIntervalMs:
      options?.sweepIntervalMs !== undefined
        ? Math.max(1, options.sweepIntervalMs)
        : interval._tag === "valid"
          ? interval.value
          : DEFAULT_SWEEP_INTERVAL_MS,
    invalidEnv: [
      ...(idle._tag === "invalid" ? [{ name: IDLE_ENV, raw: idle.raw }] : []),
      ...(interval._tag === "invalid" ? [{ name: INTERVAL_ENV, raw: interval.raw }] : []),
    ],
  };
};

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const { inactivityThresholdMs, sweepIntervalMs, invalidEnv } =
      resolveProviderSessionReaperOptions(options, process.env);

    yield* Effect.forEach(
      invalidEnv,
      (entry) =>
        Effect.logWarning("provider.session.reaper.invalid-env", {
          name: entry.name,
          value: entry.raw,
          reason: "expected a positive number of milliseconds; using the default",
        }),
      { discard: true },
    );

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        if (now - lastSeenMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        // Ingestion updates this timestamp alongside activeTurnId when a turn
        // settles. Long turns must get a full idle window after that transition,
        // even though the binding was last touched when the turn was sent.
        const lastActivityMs = Math.max(
          lastSeenMs,
          Date.parse(thread?.session?.updatedAt ?? binding.lastSeenAt),
        );
        const idleDurationMs = now - lastActivityMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
