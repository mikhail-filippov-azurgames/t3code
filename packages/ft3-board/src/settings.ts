/**
 * Fork-owned server settings: board retention, coordinator nudges and the
 * deleted-thread purge window.
 *
 * Upstream `ServerSettings` only carries the generic `ft3` namespace; the
 * typed schema, bounds and defaults live here so the upstream schema stays a
 * single connection point.
 *
 * @module ft3-board/settings
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const MIN_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES = 5;
export const MAX_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES = 1440;
export const MIN_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD = 1;
export const MAX_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD = 20;
export const MIN_BOARD_ARCHIVE_AFTER_DAYS = 1;
export const MAX_BOARD_ARCHIVE_AFTER_DAYS = 3650;
export const MIN_BOARD_DELETE_ARCHIVED_AFTER_DAYS = 1;
export const MAX_BOARD_DELETE_ARCHIVED_AFTER_DAYS = 3650;
export const MIN_DELETED_THREAD_PURGE_AFTER_DAYS = 1;
export const MAX_DELETED_THREAD_PURGE_AFTER_DAYS = 3650;

const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

export const CoordinatorBoardNudgeIntervalMinutes = boundedInt(
  MIN_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES,
  MAX_COORDINATOR_BOARD_NUDGE_INTERVAL_MINUTES,
);
export type CoordinatorBoardNudgeIntervalMinutes = typeof CoordinatorBoardNudgeIntervalMinutes.Type;
export const CoordinatorBoardNudgeActiveChildThreshold = boundedInt(
  MIN_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD,
  MAX_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD,
);
export type CoordinatorBoardNudgeActiveChildThreshold =
  typeof CoordinatorBoardNudgeActiveChildThreshold.Type;
export const BoardArchiveAfterDays = boundedInt(
  MIN_BOARD_ARCHIVE_AFTER_DAYS,
  MAX_BOARD_ARCHIVE_AFTER_DAYS,
);
export type BoardArchiveAfterDays = typeof BoardArchiveAfterDays.Type;
export const BoardDeleteArchivedAfterDays = boundedInt(
  MIN_BOARD_DELETE_ARCHIVED_AFTER_DAYS,
  MAX_BOARD_DELETE_ARCHIVED_AFTER_DAYS,
);
export type BoardDeleteArchivedAfterDays = typeof BoardDeleteArchivedAfterDays.Type;
export const DeletedThreadPurgeAfterDays = boundedInt(
  MIN_DELETED_THREAD_PURGE_AFTER_DAYS,
  MAX_DELETED_THREAD_PURGE_AFTER_DAYS,
);
export type DeletedThreadPurgeAfterDays = typeof DeletedThreadPurgeAfterDays.Type;

const DEFAULT_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD: CoordinatorBoardNudgeActiveChildThreshold = 1;
const DEFAULT_BOARD_ARCHIVE_AFTER_DAYS: BoardArchiveAfterDays = 1;
const DEFAULT_BOARD_DELETE_ARCHIVED_AFTER_DAYS: BoardDeleteArchivedAfterDays = 14;
const DEFAULT_DELETED_THREAD_PURGE_AFTER_DAYS: DeletedThreadPurgeAfterDays = 14;

export const BoardAutomationSettings = Schema.Struct({
  coordinatorBoardNudgeIntervalMinutes: Schema.NullOr(CoordinatorBoardNudgeIntervalMinutes).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  coordinatorBoardNudgeActiveChildThreshold: CoordinatorBoardNudgeActiveChildThreshold.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_COORDINATOR_BOARD_NUDGE_ACTIVE_CHILD_THRESHOLD),
    ),
  ),
  boardArchiveAfterDays: BoardArchiveAfterDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_ARCHIVE_AFTER_DAYS)),
  ),
  boardDeleteArchivedAfterDays: BoardDeleteArchivedAfterDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOARD_DELETE_ARCHIVED_AFTER_DAYS)),
  ),
  deletedThreadPurgeAfterDays: DeletedThreadPurgeAfterDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELETED_THREAD_PURGE_AFTER_DAYS)),
  ),
});
export type BoardAutomationSettings = typeof BoardAutomationSettings.Type;

export const DEFAULT_BOARD_AUTOMATION_SETTINGS: BoardAutomationSettings = Schema.decodeSync(
  BoardAutomationSettings,
)({});

const decodeBoardAutomationSettings = Schema.decodeUnknownOption(BoardAutomationSettings);

/** Unknown or corrupt stored values fall back to the defaults instead of failing a reactor. */
export function readBoardAutomationSettings(
  raw: Readonly<Record<string, unknown>> | undefined,
): BoardAutomationSettings {
  return Option.getOrElse(decodeBoardAutomationSettings(raw ?? {}), () => ({
    ...DEFAULT_BOARD_AUTOMATION_SETTINGS,
  }));
}
