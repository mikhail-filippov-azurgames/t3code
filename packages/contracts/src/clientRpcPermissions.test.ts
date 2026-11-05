import { describe, expect, it } from "@effect/vitest";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
import {
  CLIENT_GUARDED_RPC_SCOPES,
  FT3_CLIENT_GUARDED_RPC_SCOPES,
  clientRpcRequiredScopes,
} from "./clientRpcPermissions.ts";

describe("clientRpcRequiredScopes", () => {
  it("guards the policies source and feature mutations with settings:write", () => {
    expect(clientRpcRequiredScopes("policies.setDocument", undefined)).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(clientRpcRequiredScopes("policies.setFeature", undefined)).toEqual([
      AuthSettingsWriteScope,
    ]);
  });

  it("guards the docs read with orchestration:read", () => {
    expect(clientRpcRequiredScopes("docs.read", undefined)).toEqual([AuthOrchestrationReadScope]);
  });

  it("guards the plan RPCs for human clients only", () => {
    expect(clientRpcRequiredScopes("board.planGet", undefined)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(clientRpcRequiredScopes("board.planSetRequired", undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes("board.planAccept", undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("keeps the ft3 policies methods out of the upstream server scope map", () => {
    expect(Object.keys(CLIENT_GUARDED_RPC_SCOPES)).not.toContain("policies.setDocument");
    expect(Object.keys(CLIENT_GUARDED_RPC_SCOPES)).not.toContain("policies.setFeature");
    expect(Object.keys(CLIENT_GUARDED_RPC_SCOPES)).not.toContain("policies.browseServerDirectory");
    expect(clientRpcRequiredScopes("policies.browseServerDirectory", undefined)).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(Object.keys(FT3_CLIENT_GUARDED_RPC_SCOPES)).toEqual([
      "policies.setDocument",
      "policies.setFeature",
      "policies.browseServerDirectory",
    ]);
  });
});
