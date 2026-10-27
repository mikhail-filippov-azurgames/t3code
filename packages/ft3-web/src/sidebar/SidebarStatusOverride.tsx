import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";

import { useNowSecond } from "~/hooks/useNowSecond";
import { CircleDashedIcon } from "lucide-react";
import type { SidebarRowStatusOverride } from "./SidebarForestRowDecorations.tsx";

function WorkingDuration(props: { readonly startedAt: string }) {
  const startedMs = Date.parse(props.startedAt);
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking so the duration updates without re-rendering the whole row.
function WorkingDurationLabel(props: { readonly startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}

/**
 * Delegated working status for the row's right slot. The row marks its native
 * status hidden while this is mounted; the slim and full rows keep their own
 * glyph sizes.
 */
export function SidebarStatusOverride(props: {
  readonly override: SidebarRowStatusOverride | null;
}) {
  const override = props.override;
  if (override === null) return null;
  return (
    <>
      <span
        data-ft3-status-keep=""
        data-ft3-status-variant="full"
        className="inline-flex items-center gap-1 font-medium text-info-foreground"
      >
        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
        Working
        <WorkingDuration startedAt={override.startedAt} />
      </span>
      <span
        data-ft3-status-keep=""
        data-ft3-status-variant="slim"
        className="inline-flex items-center gap-1 text-xs font-medium text-info-foreground tabular-nums"
      >
        <CircleDashedIcon aria-hidden className="size-3" />
        Working <WorkingDuration startedAt={override.startedAt} />
      </span>
    </>
  );
}
