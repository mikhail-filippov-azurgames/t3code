import { FeatureGate } from "@t3tools/ft3-policies/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { TimeoutOverdueDeliveriesResult } from "./service.ts";
import { MailService } from "./service.ts";

export class MailTimeoutReactorError extends Schema.TaggedError<MailTimeoutReactorError>()(
  "MailTimeoutReactorError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `The mail timeout reactor could not ${this.operation}.`;
  }
}

/**
 * Fails pending deliveries older than the member budget (or the task default).
 * Members stay active; the lead gets one system letter per task and resends
 * anything the participant still needs. Runs on a minute tick and never
 * while the mail feature is off.
 */
export class MailTimeoutReactor extends Context.Service<
  MailTimeoutReactor,
  {
    readonly scan: (
      now: string,
    ) => Effect.Effect<TimeoutOverdueDeliveriesResult, MailTimeoutReactorError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/ft3-mail/timeoutReactor/MailTimeoutReactor") {}

export const TIMEOUT_SCAN_INTERVAL = Duration.minutes(1);

const failure = (operation: string) => (cause: unknown) =>
  new MailTimeoutReactorError({ operation, cause });

export const make = Effect.fn("MailTimeoutReactor.make")(function* () {
  const mail = yield* MailService;
  const gate = yield* FeatureGate;

  const scan = Effect.fn("MailTimeoutReactor.scan")(function* (now: string) {
    if (!(yield* gate.isEffective("mail").pipe(Effect.orElseSucceed(() => false)))) {
      return { failed: [], letters: [] } satisfies TimeoutOverdueDeliveriesResult;
    }
    return yield* mail
      .timeoutOverdueDeliveries({ now })
      .pipe(Effect.mapError(failure("scan overdue deliveries")));
  });

  const start = Effect.fn("MailTimeoutReactor.start")(function* () {
    const loopReady = yield* Deferred.make<void>();
    let signalledReady = false;
    const loop = Effect.fn("MailTimeoutReactor.loop")(function* () {
      while (true) {
        const at = DateTime.formatIso(yield* DateTime.now);
        const scanned = yield* scan(at).pipe(
          Effect.catchCause((cause) =>
            Effect.andThen(
              Effect.logWarning("Mail timeout scan failed", { cause: String(cause) }),
              Effect.succeed({ failed: [], letters: [] } satisfies TimeoutOverdueDeliveriesResult),
            ),
          ),
        );
        if (scanned.failed.length > 0) {
          yield* Effect.logInfo("Mail timeout scan failed overdue deliveries", {
            failed: scanned.failed.length,
            letters: scanned.letters.length,
          });
        }
        if (!signalledReady) {
          signalledReady = true;
          yield* Deferred.succeed(loopReady, undefined);
        }
        yield* Effect.sleep(TIMEOUT_SCAN_INTERVAL);
      }
    });

    yield* loop().pipe(Effect.forkScoped);
    yield* Deferred.await(loopReady);
  });

  return { scan, start };
});

export const layer = Layer.effect(MailTimeoutReactor, make());

export const layerWorker = () =>
  Layer.effectDiscard(Effect.flatMap(MailTimeoutReactor, (reactor) => reactor.start())).pipe(
    Layer.provide(layer),
  );
