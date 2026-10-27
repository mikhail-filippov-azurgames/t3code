import { formatUsd } from "@t3tools/shared/usageFormat";

/** Zero cost with sessions present means unknown rates, not free work. */
export function formatUsdPerSession(costUsd: number, sessions: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0 || !Number.isFinite(sessions) || sessions <= 0) {
    return "—";
  }
  return formatUsd(costUsd / sessions);
}
