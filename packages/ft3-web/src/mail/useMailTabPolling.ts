import { useEffect } from "react";

/** The mail tab revalidates at most this often while it is visible. */
export const MAIL_POLL_INTERVAL_MS = 15_000;

/**
 * Revalidates the mail tab on an interval while it stays mounted (the tab is
 * visible) and the page is visible; unmounting the tab — collapsing the panel
 * or selecting another tab — clears the interval, and hidden ticks are skipped.
 */
export function useMailTabPolling(
  onPoll: () => void,
  intervalMs = MAIL_POLL_INTERVAL_MS,
  enabled = true,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer keeps the tab's server page in step while the tab is mounted, gated on page visibility
  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") onPoll();
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [enabled, onPoll, intervalMs]);
}
