/**
 * Browser-safe RPC contracts of `ft3-policies`: `policies.getSnapshot` reports
 * the applied and last seen version of every policy document with the errors
 * and warnings of the Policies tab (design §6.3).
 */
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { PolicyDocumentKey, PolicyDocumentSource } from "./contracts.ts";
import { POLICY_ISSUE_CODES } from "./diagnostics.ts";

export const FT3_POLICIES_WS_METHODS = {
  policiesGetSnapshot: "policies.getSnapshot",
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
});
export type PolicyDocumentStatusSchema = typeof PolicyDocumentStatusSchema.Type;

export const PoliciesGetSnapshotInput = Schema.Struct({});
export type PoliciesGetSnapshotInput = typeof PoliciesGetSnapshotInput.Type;

export const PoliciesGetSnapshotResult = Schema.Struct({
  configVersion: Schema.Int,
  documents: Schema.Array(PolicyDocumentStatusSchema),
});
export type PoliciesGetSnapshotResult = typeof PoliciesGetSnapshotResult.Type;

export const policiesRpcs = [
  Rpc.make(FT3_POLICIES_WS_METHODS.policiesGetSnapshot, {
    payload: PoliciesGetSnapshotInput,
    success: PoliciesGetSnapshotResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;

export const policiesRpcScopes = {
  [FT3_POLICIES_WS_METHODS.policiesGetSnapshot]: AuthOrchestrationReadScope,
} as const;
