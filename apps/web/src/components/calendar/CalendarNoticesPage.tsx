/**
 * Notices page: every scheduled-run notification the server has posted, newest
 * first, over the device's read cursor.
 *
 * The list is the durable channel behind the sidebar badge; the badge is
 * cleared when it is pressed, not when this page is opened.
 *
 * @module components/calendar/CalendarNoticesPage
 */
import { BellIcon, BellOffIcon } from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { isNoticeUnread, sortNoticesNewestFirst, useCalendarStore } from "../../state/calendar";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Badge } from "../ui/badge";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  formatClock,
  formatDayLabel,
  formatTimeZoneLabel,
  toCalendarNoticeCard,
} from "./calendar.logic";
import { useCalendarNoticesBackend } from "./useCalendarNotices";

export function CalendarNoticesPage() {
  useCalendarNoticesBackend();
  const notices = useCalendarStore((state) => state.notices);
  const lastReadAt = useCalendarStore((state) => state.lastReadAt);
  const environmentId = usePrimaryEnvironmentId();

  const cards = useMemo(
    () =>
      sortNoticesNewestFirst(notices).map(({ notice }) =>
        toCalendarNoticeCard(notice, isNoticeUnread(notice, lastReadAt)),
      ),
    [lastReadAt, notices],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="text-sm font-medium text-foreground">Notifications</h1>
            <span className="text-xs text-muted-foreground">
              {cards.length === 1 ? "1 notice" : `${cards.length} notices`}
            </span>
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            {environmentId === null ? (
              <p className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
                No environment is connected, so there are no scheduled-run notices to show.
              </p>
            ) : cards.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <BellOffIcon className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No scheduled-run notices yet. When an event starts or one is missed, it appears
                  here.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {cards.map((card) => (
                  <li
                    key={card.key}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {card.unread ? (
                        <span
                          aria-label="Unread"
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      ) : null}
                      <BellIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {card.name}
                      </span>
                      <Badge size="sm" variant={card.status === "started" ? "success" : "warning"}>
                        {card.statusLabel}
                      </Badge>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {`${formatDayLabel(new Date(card.observedAt))} ${formatClock(new Date(card.observedAt))} ${formatTimeZoneLabel()} · scheduled ${formatClock(new Date(card.scheduledAt))}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
