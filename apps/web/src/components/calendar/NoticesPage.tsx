/**
 * Notices page: the durable device inbox, newest first.
 *
 * Every notice the client observed — calendar runs, thread completions,
 * failures and other attention states — lands here and expires 24 hours after
 * it was observed. The sidebar badge is cleared when it is pressed, not when
 * this page is opened.
 *
 * @module components/calendar/NoticesPage
 */
import { useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BellOffIcon,
  CalendarDaysIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "../../env";
import {
  isNoticeUnread,
  sortNoticesNewestFirst,
  useNotificationsStore,
  type AppNoticeKind,
} from "../../state/notifications";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useCalendarNoticesBackend } from "./useCalendarNotices";
import { formatClock, formatDayLabel } from "./calendar.logic";

const KIND_PRESENTATION: Record<
  AppNoticeKind,
  {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly variant: "secondary" | "success" | "error" | "info";
  }
> = {
  calendar: { icon: CalendarDaysIcon, label: "Scheduled run", variant: "secondary" },
  "thread-completed": { icon: CircleCheckIcon, label: "Completed", variant: "success" },
  error: { icon: TriangleAlertIcon, label: "Error", variant: "error" },
  other: { icon: BellIcon, label: "Attention", variant: "info" },
};

export function NoticesPage() {
  useCalendarNoticesBackend();
  const navigate = useNavigate();
  const notices = useNotificationsStore((state) => state.notices);
  const lastReadAt = useNotificationsStore((state) => state.lastReadAt);

  const rows = useMemo(
    () =>
      sortNoticesNewestFirst(notices).map((notice) => ({
        notice,
        unread: isNoticeUnread(notice, lastReadAt),
        presentation: KIND_PRESENTATION[notice.kind],
      })),
    [lastReadAt, notices],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="text-sm font-medium text-foreground">Notifications</h1>
            <span className="text-xs text-muted-foreground">
              {rows.length === 1 ? "1 notice" : `${rows.length} notices`}
            </span>
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <BellOffIcon className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No notifications yet. Thread completions, calendar runs and errors appear here for
                  24 hours.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map(({ notice, unread, presentation }) => {
                  const Icon = presentation.icon;
                  const { environmentId, threadId } = notice;
                  return (
                    <li
                      key={notice.key}
                      className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {unread ? (
                          <span
                            aria-label="Unread"
                            className="size-1.5 shrink-0 rounded-full bg-primary"
                          />
                        ) : null}
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {notice.title}
                        </span>
                        <Badge size="sm" variant={presentation.variant}>
                          {presentation.label}
                        </Badge>
                      </div>
                      {notice.body ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {notice.body}
                        </span>
                      ) : null}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {`${formatDayLabel(new Date(notice.at))} ${formatClock(new Date(notice.at))}`}
                        </span>
                        {environmentId !== null && threadId !== null ? (
                          <Button
                            size="micro"
                            variant="ghost"
                            onClick={() =>
                              void navigate({
                                to: "/$environmentId/$threadId",
                                params: { environmentId, threadId },
                              })
                            }
                          >
                            Open thread
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
