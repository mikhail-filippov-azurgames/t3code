/**
 * Chat header toolbar control for the Coordinator thread actions. It renders
 * nothing unless the board action set is non-empty, and otherwise opens a menu
 * over the shared item set next to the project actions control.
 *
 * @module components/board/BoardThreadActionsControl
 */
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type BoardThreadActionId,
  type BoardThreadActionsControlModel,
} from "./boardThreadActions.logic";
import { OrchestratorIcon, ORCHESTRATOR_ICON_CLASS } from "./boardRoleIcons";

export interface BoardThreadActionsControlProps {
  readonly model: BoardThreadActionsControlModel;
  readonly onSelect: (actionId: BoardThreadActionId) => void;
}

export function BoardThreadActionsControl({ model, onSelect }: BoardThreadActionsControlProps) {
  if (model.kind === "hidden") return null;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
                  aria-label="Coordinator actions"
                  // The tooltip wrapper replaces data-slot="button", so themed
                  // toolbar styling needs its own hook.
                  data-toolbar-control=""
                />
              }
            />
          }
        >
          <OrchestratorIcon aria-hidden className={`size-3.5 ${ORCHESTRATOR_ICON_CLASS}`} />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Coordinator
          </span>
          <ChevronDownIcon className="hidden size-3.5 opacity-70 @3xl/header-actions:block" />
        </TooltipTrigger>
        <TooltipPopup side="top">Coordinator actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        {model.topItems.map((item) => (
          <MenuItem key={item.id} onClick={() => onSelect(item.id)}>
            {item.label}
          </MenuItem>
        ))}
        {model.destructiveItems.length > 0 && model.topItems.length > 0 ? <MenuSeparator /> : null}
        {model.destructiveItems.map((item) => (
          <MenuItem key={item.id} variant="destructive" onClick={() => onSelect(item.id)}>
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
