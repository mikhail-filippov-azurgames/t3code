import { boardRpcs } from "@t3tools/ft3-board/rpc-contracts";
import { docsRpcs } from "@t3tools/ft3-docs/rpc-contracts";
import { mailRpcs } from "@t3tools/ft3-mail/rpc-contracts";
import { piRpcs } from "@t3tools/ft3-pi/rpc-contracts";
import { policiesRpcs } from "@t3tools/ft3-policies/rpc-contracts";
import { ft3VcsRpcs } from "@t3tools/ft3-vcs/rpc-contracts";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

export { FT3_DOCS_WS_METHODS } from "@t3tools/ft3-docs/rpc-contracts";
export { FT3_MAIL_WS_METHODS } from "@t3tools/ft3-mail/rpc-contracts";

export const FT3_ZAVOD_WS_METHODS = {
  zavodDetect: "zavod.detect",
  zavodConnect: "zavod.connect",
  zavodCopyPersonal: "zavod.copyPersonal",
} as const;

export const ZavodStatus = Schema.Struct({
  state: Schema.Literals(["on", "off", "mixed", "unsupported", "absent"]),
  baseUrl: Schema.NullOr(Schema.String),
  // Older clients decode only state/default here; newer ones read baseUrlOrigin.
  baseUrlSource: Schema.NullOr(Schema.Literals(["state", "default"])),
  baseUrlOrigin: Schema.optionalKey(Schema.Literals(["state", "codex", "claude"])),
  reason: Schema.NullOr(Schema.String),
});
export type ZavodStatus = typeof ZavodStatus.Type;

export const ZavodConnectResult = Schema.Struct({
  ...ZavodStatus.fields,
  claudeInstanceId: ProviderInstanceId,
  codexInstanceId: ProviderInstanceId,
  personalCopy: Schema.optionalKey(Schema.Literals(["copied", "failed"])),
});
export type ZavodConnectResult = typeof ZavodConnectResult.Type;

export const ZavodCopyPersonalResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      family: Schema.Literals(["claude", "codex"]),
      path: Schema.String,
      action: Schema.Literals(["create", "overwrite", "merge", "delete"]),
    }),
  ),
  skipped: Schema.Array(
    Schema.Struct({
      family: Schema.Literals(["claude", "codex"]),
      path: Schema.String,
      reason: Schema.Literals(["secret", "invalid", "link"]),
    }),
  ),
});
export type ZavodCopyPersonalResult = typeof ZavodCopyPersonalResult.Type;

export class ZavodRpcError extends Schema.TaggedError<
  ZavodRpcError,
  { readonly brand: unique symbol }
>()("ZavodRpcError", {
  operation: Schema.Literals(["detect", "connect", "copy"]),
  stage: Schema.Literals([
    "settings",
    "state",
    "conflict",
    "configuration",
    "write",
    "rollback",
    "limit",
    "copy",
  ]),
  instanceId: Schema.optionalKey(ProviderInstanceId),
}) {
  override get message(): string {
    return "Zavod request failed.";
  }
}

export const zavodRpcs = [
  Rpc.make(FT3_ZAVOD_WS_METHODS.zavodDetect, {
    payload: Schema.Struct({}),
    success: ZavodStatus,
    error: Schema.Union([EnvironmentAuthorizationError, ZavodRpcError]),
  }),
  Rpc.make(FT3_ZAVOD_WS_METHODS.zavodConnect, {
    payload: Schema.Struct({}),
    success: ZavodConnectResult,
    error: Schema.Union([EnvironmentAuthorizationError, ZavodRpcError]),
  }),
  Rpc.make(FT3_ZAVOD_WS_METHODS.zavodCopyPersonal, {
    payload: Schema.Struct({ dryRun: Schema.Boolean }),
    success: ZavodCopyPersonalResult,
    error: Schema.Union([EnvironmentAuthorizationError, ZavodRpcError]),
  }),
] as const;

export const zavodRpcScopes = {
  [FT3_ZAVOD_WS_METHODS.zavodDetect]: AuthOrchestrationReadScope,
  [FT3_ZAVOD_WS_METHODS.zavodConnect]: AuthProvidersManageScope,
  [FT3_ZAVOD_WS_METHODS.zavodCopyPersonal]: AuthProvidersManageScope,
} as const;

export const group = RpcGroup.make(
  ...boardRpcs,
  ...piRpcs,
  ...ft3VcsRpcs,
  ...docsRpcs,
  ...policiesRpcs,
  ...mailRpcs,
  ...zavodRpcs,
);
