import * as EffectAcpErrors from "effect-acp/errors";

export { AcpRegistryDriver, type AcpRegistryDriverEnv } from "./server/driver.ts";
export type { AcpRegistryDriverCreateOptions } from "./server/driver.ts";
export {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "./server/adapter.ts";
export type { AcpRegistryAdapterV2DriverCreateOptions } from "./server/adapter.ts";
export { acpRegistryManagedBinaryDirectories } from "./server/AcpRegistrySupport.ts";

export type AcpSessionRuntimeService =
  import("@t3tools/provider-acp/server/AcpSessionRuntime").AcpSessionRuntime["Service"];
export type AcpSessionNotification = import("effect-acp/compat").SessionNotification;
export type AcpSessionUpdate = import("effect-acp/compat").SessionUpdate;
export type AcpPromptResponse = import("effect-acp/compat").PromptResponse;

export const makeAcpRequestError = (errorMessage: string) =>
  new EffectAcpErrors.AcpRequestError({ code: -32000, errorMessage });
