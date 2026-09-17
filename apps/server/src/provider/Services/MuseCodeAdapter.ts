import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

/** Muse Code adapter contract: MSP session/turn/approval runtime. */
export interface MuseCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
