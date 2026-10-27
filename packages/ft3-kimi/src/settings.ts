import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";

const KIMI_AGENT_ID = "kimi";
const KIMI_EXECUTABLE = "kimi";

export function executableStem(commandPath: string): string {
  const normalized = commandPath.trim().replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

/** Limits and usage are Kimi-specific: only a Kimi ACP instance may publish them. */
export function isKimiAcpSettings(config: AcpRegistrySettings): boolean {
  if (config.source === "registry") {
    return config.agentId.trim().toLowerCase() === KIMI_AGENT_ID;
  }
  return executableStem(config.commandPath) === KIMI_EXECUTABLE;
}
