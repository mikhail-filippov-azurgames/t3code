import type { ZavodStatus } from "@t3tools/ft3-host/rpc-contracts";

/** The line under "Claude and Codex" for a loaded, supported-or-not Zavod status. */
export function zavodStatusDescription(status: ZavodStatus, connected: boolean): string {
  if (status.state === "on") return "Claude and Codex already use Zavod.";
  if (status.state === "off") {
    return connected
      ? "Claude and Codex go through Zavod instances."
      : "Connect Claude and Codex through Zavod.";
  }
  return status.reason ?? "Check the Claude and Codex configuration before connecting Zavod.";
}
