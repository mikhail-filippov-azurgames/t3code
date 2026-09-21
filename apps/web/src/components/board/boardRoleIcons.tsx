/**
 * Icons that identify board roles and the orchestrator mark.
 *
 * The orchestrator marker reuses the sidebar "Working" sky hue so a marked
 * chat reads the same everywhere; executor role icons stay neutral gray
 * because the role is metadata, not status.
 *
 * @module components/board/boardRoleIcons
 */
import type { BoardExecutorRole } from "@t3tools/contracts";
import {
  BookOpen,
  CodeXml,
  Layers,
  Share2,
  ShieldCheck,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** Matches the sidebar "Working" label (`text-sky-600 dark:text-sky-400`). */
export const ORCHESTRATOR_ICON_CLASS = "text-sky-600 dark:text-sky-400";

export const OrchestratorIcon = Workflow;

export const BOARD_ROLE_ICONS: Readonly<Record<BoardExecutorRole, LucideIcon>> = {
  architecture: Layers,
  implementation: CodeXml,
  review: Share2,
  test: ShieldCheck,
  research: BookOpen,
  general: Wrench,
};

export function BoardRoleIcon(props: {
  readonly role: BoardExecutorRole;
  readonly className?: string;
}) {
  const Icon = BOARD_ROLE_ICONS[props.role];
  return <Icon aria-hidden className={props.className ?? "size-3 shrink-0"} />;
}
