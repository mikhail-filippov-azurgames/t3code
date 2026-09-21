/**
 * Schedule page: a Google-Calendar-shaped grid over the server's events, plus
 * the upcoming list that reaches past the visible window.
 *
 * Events live on the primary environment's server; create/delete run through
 * `calendar.create` / `calendar.delete` and a failed read leaves the page with
 * the server's own error rather than inventing browser-only events.
 *
 * @module components/calendar/CalendarPage
 */
import type {
  CalendarCreateInput,
  CalendarEvent,
  CalendarEventId,
  CalendarUpdateInput,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { isElectron } from "../../env";
import { toastManager } from "../ui/toast";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { calendarFailureText, useCalendarStore } from "../../state/calendar";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CalendarEventDialog } from "./CalendarEventDialog";
import { CalendarWeekGrid } from "./CalendarWeekGrid";
import { calendarEnvironment, useCalendarBackend } from "./useCalendarBackend";
import {
  addDays,
  formatClock,
  formatDayLabel,
  formatTimeZoneLabel,
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
  useCalendarBackend();
  const events = useCalendarStore((state) => state.events);
  const transport = useCalendarStore((state) => state.transport);
  const error = useCalendarStore((state) => state.error);
  const upsertEvent = useCalendarStore((state) => state.upsertEvent);
  const removeEvent = useCalendarStore((state) => state.removeEvent);
  const environmentId = usePrimaryEnvironmentId();
  const createCalendarEvent = useAtomCommand(calendarEnvironment.create, {
    reportFailure: false,
  });
  const updateCalendarEvent = useAtomCommand(calendarEnvironment.update, {
    reportFailure: false,
  });
  const deleteCalendarEvent = useAtomCommand(calendarEnvironment.delete, {
    reportFailure: false,
  });
  const projects = useProjects();
  const { environments } = useEnvironments();

  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
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
  const rangeEnd = useMemo(() => addDays(rangeStart, view === "week" ? 7 : 1), [rangeStart, view]);

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

  const handleCreate = async (input: CalendarCreateInput) => {
    if (environmentId === null) {
      throw new Error("Connect an environment before scheduling a task.");
    }
    const result = await createCalendarEvent({ environmentId, input });
    if (AsyncResult.isSuccess(result)) {
      upsertEvent(result.value);
      toastManager.add({
        type: "success",
        title: "Scheduled task saved",
        description: "Saved on the calendar server, which runs it on schedule.",
        data: { hideCopyButton: true },
      });
      return;
    }
    throw new Error(calendarFailureText(result.cause));
  };

  const handleUpdate = async (input: CalendarUpdateInput) => {
    if (environmentId === null) {
      throw new Error("Connect an environment before scheduling a task.");
    }
    const result = await updateCalendarEvent({ environmentId, input });
    if (AsyncResult.isSuccess(result)) {
      upsertEvent(result.value);
      toastManager.add({
        type: "success",
        title: "Scheduled task updated",
        description: "Saved on the calendar server, which runs it on schedule.",
        data: { hideCopyButton: true },
      });
      return;
    }
    throw new Error(calendarFailureText(result.cause));
  };

  const handleDelete = async (eventId: CalendarEventId) => {
    if (environmentId === null) return;
    const result = await deleteCalendarEvent({ environmentId, input: { eventId } });
    if (AsyncResult.isSuccess(result)) {
      removeEvent(eventId);
      setSelectedEventId(null);
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not delete the scheduled task",
      description: calendarFailureText(result.cause),
      data: { hideCopyButton: true },
    });
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
            <Button size="sm" disabled={transport !== "live"} onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              New event
            </Button>
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            {transport === "live" ? null : (
              <p className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
                {environmentId === null
                  ? "No environment is connected."
                  : error === null
                    ? "Connecting to the calendar server…"
                    : `Calendar server unavailable: ${error}`}{" "}
                Events are stored on the server, so new tasks and deletions stay unavailable until
                it reconnects.
              </p>
            )}

            {selectedEvent !== null ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {selectedEvent.title}
                  </span>
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
                            aria-label="Edit event"
                            onClick={() => setEditOpen(true)}
                          >
                            <PencilIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Edit</TooltipPopup>
                    </Tooltip>
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
                  {`cron ${selectedEvent.cronExpression} · next ${formatClock(new Date(selectedEvent.nextFireAt))} ${formatTimeZoneLabel()}`}
                </p>
              </div>
            ) : null}

            {events.length === 0 ? (
              transport === "live" ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                  <p className="text-sm text-muted-foreground">
                    No scheduled tasks yet. Create one to deliver a prepared message on a schedule.
                  </p>
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <PlusIcon />
                    New event
                  </Button>
                </div>
              ) : null
            ) : (
              <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
                <CalendarWeekGrid
                  events={events}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  selectedEventId={selectedEventId}
                  onSelectEvent={(eventId) => setSelectedEventId(eventId as CalendarEventId)}
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
                              {`${formatDayLabel(start)} ${formatClock(start)}`}
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

      {createOpen && environmentId !== null ? (
        <CalendarEventDialog
          environmentId={environmentId}
          transport={transport}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
        />
      ) : null}

      {editOpen && selectedEvent !== null && environmentId !== null ? (
        <CalendarEventDialog
          environmentId={environmentId}
          transport={transport}
          event={selectedEvent}
          onClose={() => setEditOpen(false)}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
        />
      ) : null}
    </SidebarInset>
  );
}
