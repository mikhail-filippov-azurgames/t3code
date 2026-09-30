import { IsoDateTime, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type DelegatedSummarySource = "model" | "deterministic";
export type DelegatedSummaryState = "pending" | "ready" | "error";

export interface DelegatedTaskSummaryRecord {
  readonly childThreadId: ThreadId;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly completedAt: IsoDateTime;
  readonly text: string;
  readonly source: DelegatedSummarySource;
  readonly sourceTurnIds: ReadonlyArray<TurnId>;
  readonly watermark: number;
  readonly contentFingerprint: string;
  readonly state: DelegatedSummaryState;
  readonly error: string | null;
  readonly attemptCount: number;
  readonly retryAfter: IsoDateTime | null;
  readonly updatedAt: IsoDateTime;
}

export class DelegatedTaskSummaryRepositoryError extends Schema.TaggedError<DelegatedTaskSummaryRepositoryError>()(
  "DelegatedTaskSummaryRepositoryError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface DelegatedTaskSummaryRepositoryShape {
  readonly getByTurn: (input: {
    readonly childThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
  }) => Effect.Effect<DelegatedTaskSummaryRecord | null, DelegatedTaskSummaryRepositoryError>;
  readonly getLatestByChild: (
    childThreadId: ThreadId,
  ) => Effect.Effect<DelegatedTaskSummaryRecord | null, DelegatedTaskSummaryRepositoryError>;
  readonly getLatestBefore: (input: {
    readonly childThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
    readonly completedAt: IsoDateTime;
  }) => Effect.Effect<DelegatedTaskSummaryRecord | null, DelegatedTaskSummaryRepositoryError>;
  readonly listByParent: (input: {
    readonly parentEnvironmentId: string;
    readonly parentThreadId: ThreadId;
  }) => Effect.Effect<
    ReadonlyArray<DelegatedTaskSummaryRecord>,
    DelegatedTaskSummaryRepositoryError
  >;
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<DelegatedTaskSummaryRecord>,
    DelegatedTaskSummaryRepositoryError
  >;
  readonly insertPending: (
    row: DelegatedTaskSummaryRecord,
  ) => Effect.Effect<void, DelegatedTaskSummaryRepositoryError>;
  /** Atomically claims the one billable generator call for this child turn. */
  readonly claimGeneration: (input: {
    readonly childThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
    readonly retryAfter: IsoDateTime;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<boolean, DelegatedTaskSummaryRepositoryError>;
  readonly complete: (input: {
    readonly childThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
    readonly text: string;
    readonly source: DelegatedSummarySource;
    readonly sourceTurnIds: ReadonlyArray<TurnId>;
    readonly watermark: number;
    readonly contentFingerprint: string;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, DelegatedTaskSummaryRepositoryError>;
  readonly fail: (input: {
    readonly childThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
    readonly error: string;
    readonly retryAfter: IsoDateTime | null;
    readonly final: boolean;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, DelegatedTaskSummaryRepositoryError>;
}

export class DelegatedTaskSummaryRepository extends Context.Service<
  DelegatedTaskSummaryRepository,
  DelegatedTaskSummaryRepositoryShape
>()("t3/persistence/Services/DelegatedTaskSummaries/DelegatedTaskSummaryRepository") {}
