/**
 * Time-table week/day grid: a time gutter, one column per day, and one row per
 * hour. Cards stack vertically inside their hour slot, which grows with the
 * number of cards, so parallel occurrences never overlap and never shrink in
 * width. The contract carries no end time, so a card has a fixed height.
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
  formatTimeZoneLabel,
  layoutCalendarSlots,
  layoutOccurrences,
  startOfDay,
} from "./calendar.logic";

const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const CARD_HEIGHT = Math.round((DEFAULT_EVENT_MINUTES / 60) * HOUR_HEIGHT);
const CARD_GAP = 2;
const SLOT_ROW_INSET = 4;
/** An empty or single-card slot keeps one card's height; extra cards add rows. */
const BASE_ROW_HEIGHT = CARD_HEIGHT + SLOT_ROW_INSET;
const PER_CARD_ROW_HEIGHT = CARD_HEIGHT + CARD_GAP;

export interface CalendarWeekGridProps {
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
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

function chipClass(selected: boolean): string {
  return cn(
    "w-full overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-xs leading-tight",
    "border-primary/30 bg-primary/10 text-foreground hover:bg-primary/15",
    selected && "ring-2 ring-ring",
  );
}

export function CalendarWeekGrid({
  events,
  rangeStart,
  rangeEnd,
  selectedEventId = null,
  onSelectEvent,
}: CalendarWeekGridProps) {
  const days = useMemo(() => dayKeys(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const occurrences = useMemo(
    () => layoutOccurrences(events, rangeStart, rangeEnd),
    [events, rangeStart, rangeEnd],
  );
  const slots = useMemo(
    () =>
      layoutCalendarSlots(occurrences, days, {
        baseRowHeight: BASE_ROW_HEIGHT,
        perOccurrenceHeight: PER_CARD_ROW_HEIGHT,
      }),
    [occurrences, days],
  );

  const gridTemplateColumns = `4rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid border-b border-border" style={{ gridTemplateColumns }}>
        <div className="border-r border-border py-1.5 text-center text-[11px] text-muted-foreground">
          {formatTimeZoneLabel(rangeStart)}
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
          <div className="border-r border-border">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="relative"
                style={{ height: slots.rowHeights[hour] ?? BASE_ROW_HEIGHT }}
              >
                {hour === 0 ? null : (
                  <div className="absolute right-1.5 top-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums">
                    {formatClock(new Date(2000, 0, 1, hour))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const daySlots = slots.byDay.get(day.getTime());
            return (
              <div key={day.toISOString()} className="border-r border-border last:border-r-0">
                {HOURS.map((hour) => {
                  const hourOccurrences = daySlots?.get(hour) ?? [];
                  return (
                    <div
                      key={hour}
                      className="flex flex-col gap-0.5 overflow-hidden border-t border-border/60 p-0.5"
                      style={{ height: slots.rowHeights[hour] ?? BASE_ROW_HEIGHT }}
                    >
                      {hourOccurrences.map((occurrence) => {
                        const selected = selectedEventId === (occurrence.event.eventId as string);
                        return (
                          <button
                            key={`${occurrence.event.eventId}:${occurrence.start.toISOString()}`}
                            type="button"
                            className={chipClass(selected)}
                            style={{ height: CARD_HEIGHT }}
                            onClick={() => onSelectEvent?.(occurrence.event.eventId as string)}
                          >
                            <span className="block truncate font-medium">
                              {occurrence.event.title}
                            </span>
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {formatClock(occurrence.start)}
                              {occurrence.event.mode === "continue" ? " · continues" : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
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
