import * as EffectAcpErrors from "effect-acp/errors";

export {
  AcpRegistryDriver,
  type AcpRegistryDriverCreateOptions,
  type AcpRegistryDriverEnv,
} from "./server/driver.ts";
export {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverCreateOptions,
  type AcpRegistryAdapterV2DriverEnv,
} from "./server/adapter.ts";
export { acpRegistryManagedBinaryDirectories } from "./server/AcpRegistrySupport.ts";

export type AcpSessionRuntimeService =
  import("@t3tools/provider-acp/server/AcpSessionRuntime").AcpSessionRuntime["Service"];
export type AcpSessionNotification = import("effect-acp/compat").SessionNotification;
export type AcpSessionUpdate = import("effect-acp/compat").SessionUpdate;
export type AcpPromptResponse = import("effect-acp/compat").PromptResponse;

export const makeAcpRequestError = (errorMessage: string) =>
  new EffectAcpErrors.AcpRequestError({ code: -32000, errorMessage });
