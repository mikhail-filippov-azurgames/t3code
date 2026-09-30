import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderSetupInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderSetupInput = typeof ProviderSetupInput.Type;

const SetupOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProviderAuthState = Schema.Struct({
  instanceId: ProviderInstanceId,
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  flowId: Schema.NullOr(SetupOperationId),
  authorizationUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
});
export type ProviderAuthState = typeof ProviderAuthState.Type;

export const ProviderAuthCompleteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type ProviderAuthCompleteInput = typeof ProviderAuthCompleteInput.Type;

export const ProviderAuthCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
});
export type ProviderAuthCancelInput = typeof ProviderAuthCancelInput.Type;

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProviderInstallState = Schema.Struct({
  driver: ProviderDriverKind,
  operationId: Schema.NullOr(SetupOperationId),
  phase: Schema.Literals([
    "idle",
    "downloading",
    "extracting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  downloadedBytes: ByteCount,
  totalBytes: Schema.NullOr(ByteCount),
  version: Schema.NullOr(TrimmedNonEmptyString),
  installedVersion: Schema.NullOr(TrimmedNonEmptyString),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ProviderInstallState = typeof ProviderInstallState.Type;

export const ProviderInstallCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: SetupOperationId,
});
export type ProviderInstallCancelInput = typeof ProviderInstallCancelInput.Type;

export const PiInferenceServerInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: Schema.optional(ThreadId),
  model: Schema.optional(Schema.String),
});
export type PiInferenceServerInput = typeof PiInferenceServerInput.Type;

export const PiBonsaiPresetDetectInput = Schema.Struct({
  rootPath: Schema.optional(Schema.String),
});
export type PiBonsaiPresetDetectInput = typeof PiBonsaiPresetDetectInput.Type;

export const PiInferenceServerStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  endpoint: Schema.String,
  local: Schema.Boolean,
  phase: Schema.Literals(["stopped", "starting", "running", "ready", "failed"]),
  owner: Schema.Literals(["none", "ft3", "external"]),
  ready: Schema.Boolean,
  canStart: Schema.Boolean,
  canStop: Schema.Boolean,
  pendingRestart: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  orphanedManagedEndpoint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usedByOtherInstances: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  progress: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  modelIds: Schema.Array(TrimmedNonEmptyString),
});
export type PiInferenceServerStatus = typeof PiInferenceServerStatus.Type;

/** Bonsai launch config discovered on the FT3 host; paths are suggestions, never defaults. */
export const PiBonsaiPreset = Schema.Struct({
  executablePath: TrimmedNonEmptyString,
  modelPath: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  // FT3 passes this stable alias to llama-server, so selection works before startup.
  model: TrimmedNonEmptyString,
});
export type PiBonsaiPreset = typeof PiBonsaiPreset.Type;

/** Safe setup failure text. Never include OAuth codes, URLs, or native token data. */
export class ProviderSetupError extends Schema.TaggedError<ProviderSetupError>()(
  "ProviderSetupError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
