/**
 * Schedule page: a Google-Calendar-shaped grid over the events the client
 * knows about, plus the upcoming list that reaches past the visible window.
 *
 * Create/delete are local until `calendar.create` / `calendar.delete` join
 * `WsRpcGroup`; the banner and the per-chip "local" marker keep that visible
 * rather than silently faking a saved event.
 *
 * @module components/calendar/CalendarPage
 */
import type { CalendarCreateInput, CalendarEvent, CalendarEventId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { isElectron } from "../../env";
import { toastManager } from "../ui/toast";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useCalendarStore } from "../../state/calendar";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CalendarEventDialog } from "./CalendarEventDialog";
import { CalendarWeekGrid } from "./CalendarWeekGrid";
import {
  addDays,
  formatClock,
  formatDayLabel,
  nextCronOccurrence,
  startOfDay,
  startOfWeek,
} from "./calendar.logic";

const WEEK_STARTS_ON = 0;
const UPCOMING_LIMIT = 8;
const UPCOMING_HORIZON_DAYS = 120;

type CalendarView = "week" | "day";

interface UpcomingEntry {
  readonly event: CalendarEvent;
  readonly start: Date;
}

export function CalendarPage() {
  const events = useCalendarStore((state) => state.events);
  const localOnlyEventIds = useCalendarStore((state) => state.localOnlyEventIds);
  const transport = useCalendarStore((state) => state.transport);
  const createLocalEvent = useCalendarStore((state) => state.createLocalEvent);
  const removeEvent = useCalendarStore((state) => state.removeEvent);
  const projects = useProjects();
  const { environments } = useEnvironments();

  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<CalendarEventId | null>(null);

  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.title] as const)),
    [projects],
  );

  const rangeStart = useMemo(
    () => (view === "week" ? startOfWeek(anchor, WEEK_STARTS_ON) : startOfDay(anchor)),
    [anchor, view],
  );
  const rangeEnd = useMemo(
    () => addDays(rangeStart, view === "week" ? 7 : 1),
    [rangeStart, view],
  );

  const upcoming = useMemo<ReadonlyArray<UpcomingEntry>>(() => {
    const now = new Date();
    const horizon = addDays(now, UPCOMING_HORIZON_DAYS);
    return events
      .flatMap((event) => {
        const start = nextCronOccurrence(event.cronExpression, now);
        return start === null || start.getTime() > horizon.getTime() ? [] : [{ event, start }];
      })
      .toSorted((left, right) => left.start.getTime() - right.start.getTime())
      .slice(0, UPCOMING_LIMIT);
  }, [events]);

  const selectedEvent = events.find((event) => event.eventId === selectedEventId) ?? null;

  const shift = (days: number) => {
    setAnchor((current) => addDays(current, days));
    setSelectedEventId(null);
  };

  const handleCreate = (input: CalendarCreateInput) => {
    createLocalEvent(input);
    toastManager.add({
      type: "info",
      title: "Scheduled task created",
      description: "Stored in this browser until calendar.create is wired on the server.",
      data: { hideCopyButton: true },
    });
  };

  const handleDelete = (eventId: CalendarEventId) => {
    removeEvent(eventId);
    setSelectedEventId(null);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="text-sm font-medium text-foreground">Calendar</h1>
            <span className="text-xs text-muted-foreground">{formatDayLabel(anchor)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="Previous" onClick={() => shift(-7)}>
              <ChevronLeftIcon />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>
              Today
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Next" onClick={() => shift(7)}>
              <ChevronRightIcon />
            </Button>
            <Button
              size="sm"
              variant={view === "week" ? "secondary" : "ghost"}
              onClick={() => setView("week")}
            >
              Week
            </Button>
            <Button
              size="sm"
              variant={view === "day" ? "secondary" : "ghost"}
              onClick={() => setView("day")}
            >
              Day
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              New event
            </Button>
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            {transport === "unwired" ? (
              <p className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
                Calendar backend is not connected yet. <code>calendar.list</code>,{" "}
                <code>calendar.create</code> and <code>calendar.delete</code> are defined in the
                contract but are not server RPCs, so events created here are kept in this browser
                only.
              </p>
            ) : null}

            {selectedEvent !== null ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">{selectedEvent.title}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-xs text-muted-foreground">
                      {`${projectTitles.get(selectedEvent.projectId as string) ?? selectedEvent.projectId} · ${selectedEvent.mode}`}
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Delete event"
                            onClick={() => handleDelete(selectedEvent.eventId)}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Delete</TooltipPopup>
                    </Tooltip>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {selectedEvent.message}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {`cron ${selectedEvent.cronExpression} · ${selectedEvent.timeZone} · next ${formatClock(new Date(selectedEvent.nextFireAt))}`}
                </p>
              </div>
            ) : null}

            {events.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  No scheduled tasks yet. Create one to deliver a prepared message on a schedule.
                </p>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <PlusIcon />
                  New event
                </Button>
              </div>
            ) : (
              <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
                <CalendarWeekGrid
                  events={events}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  localOnlyEventIds={localOnlyEventIds}
                  selectedEventId={selectedEventId}
                  onSelectEvent={(eventId) =>
                    setSelectedEventId(eventId as CalendarEventId)
                  }
                />
                <section className="flex min-w-0 flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Upcoming</h2>
                  {upcoming.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No fire time in the next {UPCOMING_HORIZON_DAYS} days.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {upcoming.map(({ event, start }) => (
                        <li key={`${event.eventId}:${start.toISOString()}`}>
                          <button
                            type="button"
                            className="flex w-full min-w-0 flex-col rounded-md border border-border bg-card px-2.5 py-1.5 text-left hover:bg-accent/40"
                            onClick={() => setSelectedEventId(event.eventId)}
                          >
                            <span className="truncate text-xs font-medium">{event.title}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {`${formatDayLabel(start)} ${formatClock(start)}${localOnlyEventIds.has(event.eventId) ? " · local" : ""}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {environmentLabels.size === 0
                      ? "Connect an environment to schedule tasks."
                      : `${events.length} scheduled ${events.length === 1 ? "task" : "tasks"}`}
                  </p>
                </section>
              </div>
            )}
          </WorkspacePageContainer>
        </div>
      </div>

      {createOpen ? (
        <CalendarEventDialog
          wiring={transport}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      ) : null}
    </SidebarInset>
  );
}
