/**
 * Shared board copy for the web and mobile clients.
 *
 * Both clients render the executor role next to the card status; the labels
 * live here once so the two copies cannot drift apart. The table is keyed by
 * the contract role, so adding a role to `EXECUTOR_ROLES` fails typecheck
 * until a label is added here.
 *
 * @module board/boardLabels
 */
import type { BoardExecutorRole } from "@t3tools/contracts";

const BOARD_EXECUTOR_ROLE_LABELS: Readonly<Record<BoardExecutorRole, string>> = {
  architecture: "Architecture",
  implementation: "Implementation",
  review: "Review",
  test: "Test",
  research: "Research",
  general: "General",
};

/** Human-readable executor-role caption shared by the web and mobile board views. */
export function boardExecutorRoleLabel(role: BoardExecutorRole): string {
  return BOARD_EXECUTOR_ROLE_LABELS[role];
}
