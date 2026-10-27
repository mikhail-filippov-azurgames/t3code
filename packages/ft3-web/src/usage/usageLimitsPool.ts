import type { LimitPool } from "@t3tools/shared/usageLimits";

/**
 * The ACP driver kind is generic, so only its instances can name the agent
 * behind a pooled limits card.
 */
export function limitPoolDisplayName(pool: LimitPool): string | null {
  if (pool.driver !== "acpRegistry") return null;
  const names = new Set(
    pool.accounts.flatMap((account) => {
      const name = account.displayName?.trim();
      return name ? [name] : [];
    }),
  );
  return names.size === 1 ? ([...names][0] as string) : null;
}
