import { BOARD_EXECUTOR_ROLES, boardExecutorRoleLabel } from "../board/board.logic.ts";
import type { ExecutorRole as BoardExecutorRole } from "@t3tools/ft3-board/contracts";

/** Row decoration role badge: Coordinator mark or board role glyph. */
export type SidebarRoleBadge =
  | {
      readonly kind: "orchestrator";
      readonly label: string;
    }
  | {
      readonly kind: "role";
      readonly role: BoardExecutorRole;
      readonly label: string;
    };

export function resolveSidebarRoleBadge(input: {
  readonly role: string | null;
  readonly isOrchestrator: boolean;
}): SidebarRoleBadge | null {
  if (input.isOrchestrator) return { kind: "orchestrator", label: "Coordinator" };
  if (input.role === "design") {
    return { kind: "role", role: "architecture", label: "Design" };
  }
  const role = BOARD_EXECUTOR_ROLES.find((candidate) => candidate === input.role);
  if (role === undefined) return null;
  return { kind: "role", role, label: boardExecutorRoleLabel(role) };
}
