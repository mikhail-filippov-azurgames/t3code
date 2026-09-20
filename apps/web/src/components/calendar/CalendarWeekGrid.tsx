/**
 * Google-Calendar-shaped week/day grid: a time gutter, one column per day, and
 * one absolutely positioned chip per occurrence. The contract carries no end
 * time, so a chip is drawn at a fixed cosmetic duration.
 *
 * @module components/calendar/CalendarWeekGrid
 */
import type { CalendarEvent } from "@t3tools/contracts";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import {
  DEFAULT_EVENT_MINUTES,
  formatClock,
  formatDayLabel,
  layoutOccurrences,
  startOfDay,
  type CalendarOccurrence,
} from "./calendar.logic";

const HOUR_HEIGHT = 48;
const DAY_HEIGHT = 24 * HOUR_HEIGHT;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export interface CalendarWeekGridProps {
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly localOnlyEventIds: ReadonlySet<string>;
  readonly selectedEventId?: string | null;
  readonly onSelectEvent?: (eventId: string) => void;
}

function dayKeys(rangeStart: Date, rangeEnd: Date): ReadonlyArray<Date> {
  const days: Date[] = [];
  for (
    let day = startOfDay(rangeStart);
    day.getTime() < rangeEnd.getTime();
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    days.push(day);
  }
  return days;
}

function chipClass(isLocalOnly: boolean, selected: boolean): string {
  return cn(
    "absolute inset-x-0.5 overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-xs leading-tight",
    "border-primary/30 bg-primary/10 text-foreground hover:bg-primary/15",
    isLocalOnly && "border-dashed",
    selected && "ring-2 ring-ring",
  );
}

export function CalendarWeekGrid({
  events,
  rangeStart,
  rangeEnd,
  localOnlyEventIds,
  selectedEventId = null,
  onSelectEvent,
}: CalendarWeekGridProps) {
  const days = useMemo(() => dayKeys(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const occurrences = useMemo(
    () => layoutOccurrences(events, rangeStart, rangeEnd),
    [events, rangeStart, rangeEnd],
  );
  const byDay = useMemo(() => {
    const grouped = new Map<number, CalendarOccurrence[]>();
    for (const occurrence of occurrences) {
      const key = startOfDay(occurrence.start).getTime();
      const list = grouped.get(key);
      if (list === undefined) grouped.set(key, [occurrence]);
      else list.push(occurrence);
    }
    return grouped;
  }, [occurrences]);

  const gridTemplateColumns = `4rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid border-b border-border" style={{ gridTemplateColumns }}>
        <div className="border-r border-border py-1.5 text-center text-[11px] text-muted-foreground">
          GMT
        </div>
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className="border-r border-border py-1.5 text-center text-xs font-medium text-foreground last:border-r-0"
          >
            {formatDayLabel(day)}
          </div>
        ))}
      </div>
      <div className="max-h-[68vh] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns }}>
          <div className="relative border-r border-border" style={{ height: DAY_HEIGHT }}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
                style={{ top: hour * HOUR_HEIGHT }}
              >
                {hour === 0 ? "" : formatClock(new Date(2000, 0, 1, hour))}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const dayOccurrences = byDay.get(day.getTime()) ?? [];
            return (
              <div
                key={day.toISOString()}
                className="relative border-r border-border last:border-r-0"
                style={{ height: DAY_HEIGHT }}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute inset-x-0 border-t border-border/60"
                    style={{ top: hour * HOUR_HEIGHT }}
                  />
                ))}
                {dayOccurrences.map((occurrence) => {
                  const minutesFromDayStart =
                    (occurrence.start.getTime() - day.getTime()) / 60_000;
                  const top = (minutesFromDayStart / 60) * HOUR_HEIGHT;
                  const height = (DEFAULT_EVENT_MINUTES / 60) * HOUR_HEIGHT;
                  const isLocalOnly = localOnlyEventIds.has(occurrence.event.eventId as string);
                  const selected = selectedEventId === (occurrence.event.eventId as string);
                  return (
                    <button
                      key={`${occurrence.event.eventId}:${occurrence.start.toISOString()}`}
                      type="button"
                      className={chipClass(isLocalOnly, selected)}
                      style={{ top, height }}
                      onClick={() => onSelectEvent?.(occurrence.event.eventId as string)}
                    >
                      <span className="block truncate font-medium">{occurrence.event.title}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {formatClock(occurrence.start)}
                        {occurrence.event.mode === "continue" ? " · continues" : ""}
                        {isLocalOnly ? " · local" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
