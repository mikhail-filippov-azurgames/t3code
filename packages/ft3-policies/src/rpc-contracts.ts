/**
 * Browser-safe RPC contracts of `ft3-policies`: the snapshot, the Policies-tab
 * editor, pending external edits and the `applyExternalEdits` toggle
 * (design §6.3). Reads use `orchestration:read`; every write needs
 * `settings:write`, the same scope as editing Settings.
 */
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { PolicyDocumentKey, PolicyDocumentSource } from "./contracts.ts";
import { POLICY_ISSUE_CODES } from "./diagnostics.ts";

export const FT3_POLICIES_WS_METHODS = {
  policiesGetSnapshot: "policies.getSnapshot",
  policiesReadDocument: "policies.readDocument",
  policiesSaveDocument: "policies.saveDocument",
  policiesGetPendingChange: "policies.getPendingChange",
  policiesApplyPending: "policies.applyPending",
  policiesSetApplyExternalEdits: "policies.setApplyExternalEdits",
} as const;

/** One diagnostic with its source line, as the Policies tab lists it. */
export const PolicyIssueSchema = Schema.Struct({
  code: Schema.Literals(POLICY_ISSUE_CODES),
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
  document: PolicyDocumentKey,
  hint: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  text: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
});
export type PolicyIssueSchema = typeof PolicyIssueSchema.Type;

export const PolicyAppliedVersionSchema = Schema.Struct({
  revision: Schema.Int,
  sha256: Schema.String,
  appliedAt: Schema.String,
});
export type PolicyAppliedVersionSchema = typeof PolicyAppliedVersionSchema.Type;

export const PolicySeenVersionSchema = Schema.Struct({
  revision: Schema.NullOr(Schema.Int),
  sha256: Schema.NullOr(Schema.String),
  issues: Schema.Array(PolicyIssueSchema),
});
export type PolicySeenVersionSchema = typeof PolicySeenVersionSchema.Type;

export const PolicyDocumentStatusSchema = Schema.Struct({
  key: PolicyDocumentKey,
  source: PolicyDocumentSource,
  configured: Schema.Boolean,
  applied: Schema.NullOr(PolicyAppliedVersionSchema),
  seen: Schema.NullOr(PolicySeenVersionSchema),
  errors: Schema.Array(PolicyIssueSchema),
  warnings: Schema.Array(PolicyIssueSchema),
  kept: Schema.Boolean,
  pending: Schema.Boolean,
});
export type PolicyDocumentStatusSchema = typeof PolicyDocumentStatusSchema.Type;

export const PoliciesGetSnapshotInput = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
});
export type PoliciesGetSnapshotInput = typeof PoliciesGetSnapshotInput.Type;

export const PoliciesGetSnapshotResult = Schema.Struct({
  configVersion: Schema.Int,
  documents: Schema.Array(PolicyDocumentStatusSchema),
  /** Migration warnings, such as an unresolvable legacy policy reference. */
  warnings: Schema.Array(PolicyIssueSchema),
});
export type PoliciesGetSnapshotResult = typeof PoliciesGetSnapshotResult.Type;

/** One file of a live policy document, as the plain-text editor reads it. */
export const PolicyDocumentFileSchema = Schema.Struct({
  file: Schema.String,
  content: Schema.String,
  sha256: Schema.String,
});
export type PolicyDocumentFileSchema = typeof PolicyDocumentFileSchema.Type;

export const PoliciesReadDocumentInput = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  key: PolicyDocumentKey,
  /** A tree file; the main document when absent. */
  file: Schema.optionalKey(Schema.String),
});
export type PoliciesReadDocumentInput = typeof PoliciesReadDocumentInput.Type;

export const PoliciesReadDocumentResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    key: PolicyDocumentKey,
    source: PolicyDocumentSource,
    configured: Schema.Boolean,
    files: Schema.Array(PolicyDocumentFileSchema),
    /** The file the editor opened when `file` was omitted. */
    mainFile: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    key: PolicyDocumentKey,
    issues: Schema.Array(PolicyIssueSchema),
  }),
]);
export type PoliciesReadDocumentResult = typeof PoliciesReadDocumentResult.Type;

const DocumentFileRef = Schema.optionalKey(Schema.String);
const DocumentSha = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const PoliciesSaveDocumentInput = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  key: PolicyDocumentKey,
  file: DocumentFileRef,
  /** Live SHA the editor started from; a mismatch is `document_changed_externally`. */
  baseSha256: DocumentSha,
  content: Schema.String,
});
export type PoliciesSaveDocumentInput = typeof PoliciesSaveDocumentInput.Type;

const PolicySaveStatus = Schema.Literals([
  "saved",
  "invalid",
  "changed_externally",
  "not_writable",
]);

export const PoliciesSaveDocumentResult = Schema.Struct({
  status: PolicySaveStatus,
  /** The snapshot after the save: applied when valid, previous version when not. */
  snapshot: PoliciesGetSnapshotResult,
});
export type PoliciesSaveDocumentResult = typeof PoliciesSaveDocumentResult.Type;

export const PolicyPendingFileSchema = Schema.Struct({
  file: Schema.String,
  appliedSha256: Schema.NullOr(Schema.String),
  liveSha256: Schema.NullOr(Schema.String),
  diff: Schema.String,
});
export type PolicyPendingFileSchema = typeof PolicyPendingFileSchema.Type;

export const PolicyPendingChangeSchema = Schema.Struct({
  liveSha256: Schema.NullOr(Schema.String),
  valid: Schema.Boolean,
  issues: Schema.Array(PolicyIssueSchema),
  files: Schema.Array(PolicyPendingFileSchema),
});
export type PolicyPendingChangeSchema = typeof PolicyPendingChangeSchema.Type;

export const PoliciesGetPendingChangeInput = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  key: PolicyDocumentKey,
});
export type PoliciesGetPendingChangeInput = typeof PoliciesGetPendingChangeInput.Type;

export const PoliciesGetPendingChangeResult = Schema.Struct({
  key: PolicyDocumentKey,
  pending: Schema.Boolean,
  change: Schema.NullOr(PolicyPendingChangeSchema),
});
export type PoliciesGetPendingChangeResult = typeof PoliciesGetPendingChangeResult.Type;

export const PoliciesApplyPendingInput = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  key: PolicyDocumentKey,
  /** Live SHA the human saw in the diff; a newer live edit is refused. */
  liveSha256: DocumentSha,
});
export type PoliciesApplyPendingInput = typeof PoliciesApplyPendingInput.Type;

const PolicyApplyStatus = Schema.Literals([
  "applied",
  "invalid",
  "changed_externally",
  "nothing_pending",
]);

export const PoliciesApplyPendingResult = Schema.Struct({
  status: PolicyApplyStatus,
  snapshot: PoliciesGetSnapshotResult,
});
export type PoliciesApplyPendingResult = typeof PoliciesApplyPendingResult.Type;

export const PoliciesSetApplyExternalEditsInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type PoliciesSetApplyExternalEditsInput = typeof PoliciesSetApplyExternalEditsInput.Type;

export const PoliciesSetApplyExternalEditsResult = Schema.Struct({
  enabled: Schema.Boolean,
  snapshot: PoliciesGetSnapshotResult,
});
export type PoliciesSetApplyExternalEditsResult = typeof PoliciesSetApplyExternalEditsResult.Type;

export const policiesRpcs = [
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesGetSnapshot, {
    payload: PoliciesGetSnapshotInput,
    success: PoliciesGetSnapshotResult,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesReadDocument, {
    payload: PoliciesReadDocumentInput,
    success: PoliciesReadDocumentResult,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesSaveDocument, {
    payload: PoliciesSaveDocumentInput,
    success: PoliciesSaveDocumentResult,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesGetPendingChange, {
    payload: PoliciesGetPendingChangeInput,
    success: PoliciesGetPendingChangeResult,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesApplyPending, {
    payload: PoliciesApplyPendingInput,
    success: PoliciesApplyPendingResult,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesSetApplyExternalEdits, {
    payload: PoliciesSetApplyExternalEditsInput,
    success: PoliciesSetApplyExternalEditsResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;

export const policiesRpcScopes = {
  [FT3_POLICIES_WS_METHODS.policiesGetSnapshot]: AuthOrchestrationReadScope,
  [FT3_POLICIES_WS_METHODS.policiesGetPendingChange]: AuthOrchestrationReadScope,
  [FT3_POLICIES_WS_METHODS.policiesReadDocument]: AuthSettingsWriteScope,
  [FT3_POLICIES_WS_METHODS.policiesSaveDocument]: AuthSettingsWriteScope,
  [FT3_POLICIES_WS_METHODS.policiesApplyPending]: AuthSettingsWriteScope,
  [FT3_POLICIES_WS_METHODS.policiesSetApplyExternalEdits]: AuthSettingsWriteScope,
} as const;
