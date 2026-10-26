import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as Contracts from "./contracts.ts";

export const FT3_ARCHITECT_WS_METHODS = {
  getCoordinatorArchitectSidebar: "orchestration.getCoordinatorArchitectSidebar",
  getCoordinatorArchitectSidebarByArchitect:
    "orchestration.getCoordinatorArchitectSidebarByArchitect",
  publishArchitectPublication: "orchestration.publishArchitectPublication",
} as const;

const ArchitectRpcError = Schema.Union([
  Contracts.ArchitectMcpFailure,
  EnvironmentAuthorizationError,
]);

export const architectRpcs = [
  Rpc.make(FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebar, {
    payload: Contracts.ArchitectGetCoordinatorSidebarInput,
    success: Contracts.ArchitectCoordinatorArchitectSidebarSnapshot,
    error: ArchitectRpcError,
  }),
  Rpc.make(FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebarByArchitect, {
    payload: Contracts.ArchitectGetSidebarByArchitectInput,
    success: Contracts.ArchitectCoordinatorArchitectSidebarSnapshot,
    error: ArchitectRpcError,
  }),
  Rpc.make(FT3_ARCHITECT_WS_METHODS.publishArchitectPublication, {
    payload: Contracts.ArchitectHumanPublicationInput,
    success: Contracts.ArchitectHumanPublicationResult,
    error: ArchitectRpcError,
  }),
] as const;

export const architectRpcScopes = {
  [FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebar]: AuthOrchestrationReadScope,
  [FT3_ARCHITECT_WS_METHODS.getCoordinatorArchitectSidebarByArchitect]: AuthOrchestrationReadScope,
  [FT3_ARCHITECT_WS_METHODS.publishArchitectPublication]: AuthOrchestrationOperateScope,
} as const;
