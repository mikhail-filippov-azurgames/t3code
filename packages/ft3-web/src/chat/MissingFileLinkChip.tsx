import type { EnvironmentId } from "@t3tools/contracts";

import { ContextChip } from "~/components/ContextChip";
import { FileTagChipContent } from "~/components/chat/FileTagChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface MissingFileLinkChipProps {
  readonly environmentId: EnvironmentId | null;
  readonly targetPath: string;
  readonly iconPath: string;
  readonly label: string;
  readonly copyMarkdown: string;
  readonly theme: "light" | "dark";
}

/**
 * A link the index and its completed parent listing both prove absent. It
 * stays a chip so the reader sees the reference, but it must not pretend to be
 * openable, and it must never appear for an ambiguous or unreachable lookup.
 */
export function MissingFileLinkChip(props: MissingFileLinkChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            state="invalid"
            dir="ltr"
            data-markdown-file-missing="true"
            data-markdown-copy={props.copyMarkdown}
            aria-label={`${props.label} not found`}
            className="select-text"
          >
            <FileTagChipContent
              path={props.iconPath}
              environmentId={props.environmentId}
              label={props.label}
              theme={props.theme}
            />
            <span className="ms-1 shrink-0">Not found</span>
          </ContextChip>
        }
      />
      <TooltipPopup side="top" variant="code">
        <div className="whitespace-nowrap">{props.targetPath} (not found)</div>
      </TooltipPopup>
    </Tooltip>
  );
}
