import { SquareKanbanIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

export function useFt3SidebarBoardMenuItem(closeMobileSidebar: () => void) {
  const navigate = useNavigate();
  return {
    icon: <SquareKanbanIcon />,
    label: "Board",
    onClick: () => {
      closeMobileSidebar();
      void navigate({ to: "/board", search: {} });
    },
  };
}
