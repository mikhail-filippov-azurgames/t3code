/**
 * Mail settings under the `ft3.mail` namespace (design §9.4). Only the kind
 * classifier threshold lives here so far; the typed schema and defaults live
 * here while upstream `ServerSettings` only carries the generic `ft3`
 * namespace.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Key of the mail namespace inside `ServerSettings.ft3`. */
export const MAIL_SETTINGS_NAMESPACE = "mail";

/** Confidence at or above which the classifier kind is authoritative for transitions. */
export const MIN_MAIL_CLASSIFIER_THRESHOLD = 0;
export const MAX_MAIL_CLASSIFIER_THRESHOLD = 1;
/** Inert while the classifier port is a no-op; chosen so a future real classifier
 *  needs clear agreement before it overrules the sender kind. */
export const DEFAULT_MAIL_CLASSIFIER_THRESHOLD = 0.8;

export const MailClassifierThreshold = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_MAIL_CLASSIFIER_THRESHOLD,
    maximum: MAX_MAIL_CLASSIFIER_THRESHOLD,
  }),
);
export type MailClassifierThreshold = typeof MailClassifierThreshold.Type;

export const MailSettings = Schema.Struct({
  classifierThreshold: MailClassifierThreshold.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAIL_CLASSIFIER_THRESHOLD)),
  ),
});
export type MailSettings = typeof MailSettings.Type;

export const DEFAULT_MAIL_SETTINGS: MailSettings = Schema.decodeSync(MailSettings)({});

const decodeMailSettings = Schema.decodeUnknownOption(MailSettings);

/** Unknown or corrupt stored values fall back to the defaults instead of failing mail. */
export function readMailSettings(
  ft3Namespace: Readonly<Record<string, unknown>> | undefined,
): MailSettings {
  return Option.getOrElse(
    decodeMailSettings(ft3Namespace?.[MAIL_SETTINGS_NAMESPACE] ?? {}),
    () => ({
      ...DEFAULT_MAIL_SETTINGS,
    }),
  );
}

export class MailSettingsService extends Context.Service<MailSettingsService, MailSettings>()(
  "@t3tools/ft3-mail/settings/MailSettingsService",
) {}

/**
 * Reads the live `ft3.mail` settings; the `ServerSettingsService` requirement
 * is expressed structurally so `ft3-mail` keeps no static import of `apps/server`.
 */
export const mailSettingsLayer: Layer.Layer<
  MailSettingsService,
  never,
  import("../../../apps/server/src/serverSettings.ts").ServerSettingsService
> = Layer.unwrap(
  Effect.promise(() => import("../../../apps/server/src/serverSettings.ts")).pipe(
    Effect.map((serverSettings) =>
      Layer.effect(
        MailSettingsService,
        Effect.gen(function* () {
          const settings = yield* serverSettings.ServerSettingsService;
          const current = yield* settings.getSettings.pipe(Effect.orDie);
          return readMailSettings(current.ft3);
        }),
      ),
    ),
  ),
);
