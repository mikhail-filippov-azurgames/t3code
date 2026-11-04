import { describe, expect, it } from "@effect/vitest";

import { AuthSettingsWriteScope } from "./auth.ts";
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

  it("keeps the ft3 policies methods out of the upstream server scope map", () => {
    expect(Object.keys(CLIENT_GUARDED_RPC_SCOPES)).not.toContain("policies.setDocument");
    expect(Object.keys(CLIENT_GUARDED_RPC_SCOPES)).not.toContain("policies.setFeature");
    expect(Object.keys(FT3_CLIENT_GUARDED_RPC_SCOPES)).toEqual([
      "policies.setDocument",
      "policies.setFeature",
    ]);
  });
});
