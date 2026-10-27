import type { PiInferenceProfileSettings } from "@t3tools/ft3-pi/rpc-contracts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isBetween = (value: number, minimum: number, maximum: number): boolean =>
  Number.isFinite(value) && value >= minimum && value <= maximum;

/** Return the first blocking problem, matching the server's launch validation. */
export function validatePiInferenceProfile(profile: PiInferenceProfileSettings): string | null {
  if (profile.model.trim().length === 0) return "The model ID is required.";
  if (profile.executablePath.trim().length === 0) {
    return "The llama-server executable path is required.";
  }
  if (profile.modelPath.trim().length === 0) return "The GGUF model file path is required.";
  try {
    const url = new URL(profile.baseUrl);
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return "The inference endpoint must use HTTP on a loopback address.";
    }
  } catch {
    return "The inference endpoint must use HTTP on a loopback address.";
  }
  if (!Number.isInteger(profile.gpuLayers) || !isBetween(profile.gpuLayers, 0, 999)) {
    return "GPU layers must be between 0 and 999.";
  }
  if (!Number.isInteger(profile.contextSize) || !isBetween(profile.contextSize, 512, 1_048_576)) {
    return "Context size must be between 512 and 1048576 tokens.";
  }
  if (!Number.isInteger(profile.parallel) || !isBetween(profile.parallel, 1, 64)) {
    return "Parallel slots must be between 1 and 64.";
  }
  if (!isBetween(profile.temperature, 0, 2)) return "Temperature must be between 0 and 2.";
  if (!isBetween(profile.topP, 0, 1)) return "Top-p must be between 0 and 1.";
  if (!Number.isInteger(profile.topK) || !isBetween(profile.topK, 0, 1000)) {
    return "Top-k must be between 0 and 1000.";
  }
  if (!isBetween(profile.minP, 0, 1)) return "Min-p must be between 0 and 1.";
  return null;
}
