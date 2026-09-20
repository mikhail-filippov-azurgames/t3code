/**
 * Create form for a scheduled event.
 *
 * The contract has no explicit datetime field: the chosen local start instant
 * and repeat compose the stored cron expression. `modelSelection` is not a form
 * field either; it is read from the chosen project's resolved settings the same
 * way a new thread picks its default.
 *
 * @module components/calendar/CalendarEventDialog
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type CalendarCreateInput,
  type CalendarEventMode,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  CALENDAR_MODE_OPTIONS,
  CALENDAR_REPEAT_OPTIONS,
  composeCron,
  formatDayLabel,
  nextCronOccurrence,
  parseCron,
  type CalendarRepeat,
} from "./calendar.logic";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultStart(): { date: string; time: string } {
  const next = new Date();
  next.setMinutes(Math.ceil((next.getMinutes() + 30) / 15) * 15, 0, 0);
  return {
    date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`,
    time: `${pad(next.getHours())}:${pad(next.getMinutes())}`,
  };
}

function parseStart(date: string, time: string): Date | null {
  if (date.length === 0) return null;
  const parsed = new Date(`${date}T${time.length === 0 ? "00:00" : time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface CalendarEventDialogProps {
  readonly wiring: "unwired" | "live";
  readonly onClose: () => void;
  readonly onSubmit: (input: CalendarCreateInput) => void;
}

export function CalendarEventDialog({ wiring, onClose, onSubmit }: CalendarEventDialogProps) {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );

  const initialStart = useMemo(() => defaultStart(), []);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [date, setDate] = useState(initialStart.date);
  const [time, setTime] = useState(initialStart.time);
  const [repeat, setRepeat] = useState<CalendarRepeat>("weekly");
  const [customCron, setCustomCron] = useState("");
  const [mode, setMode] = useState<CalendarEventMode>("new-thread");
  const [error, setError] = useState<string | null>(null);

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const resolvedSettings =
    project === null
      ? null
      : resolveProjectSettings(
          serverConfigs.get(project.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
          project.id,
          project,
        ).settings;
  const modelSelection = resolvedSettings?.defaultModelSelection ?? null;

  const start = parseStart(date, time);
  const cron = start === null ? "" : composeCron(start, repeat, customCron);
  const cronValid = parseCron(cron) !== null;
  const nextFire =
    cronValid && start !== null ? nextCronOccurrence(cron, new Date()) : null;

  const submit = () => {
    if (project === null) {
      setError("Choose a project for the scheduled thread.");
      return;
    }
    if (title.trim().length === 0) {
      setError("Enter a title.");
      return;
    }
    if (message.trim().length === 0) {
      setError("Enter the message the scheduled thread should receive.");
      return;
    }
    if (start === null) {
      setError("Choose a valid start date and time.");
      return;
    }
    if (!cronValid) {
      setError("The cron expression is not a valid five-field expression.");
      return;
    }
    if (modelSelection === null) {
      setError("This project has no default model. Set one in project settings first.");
      return;
    }
    onSubmit({
      projectId: project.id,
      title: title.trim(),
      message,
      mode,
      cronExpression: cron,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      modelSelection,
      runtimeMode: resolvedSettings?.defaultRuntimeMode ?? DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New scheduled task</DialogTitle>
            <DialogDescription>
              A prepared message is delivered to a thread on a local-time schedule.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-project">
              Project
              <Select
                value={projectId ?? ""}
                onValueChange={(value) => {
                  setProjectId(value as ProjectId);
                  setError(null);
                }}
              >
                <SelectTrigger id="calendar-project" aria-label="Project">
                  <SelectValue>
                    {project === null
                      ? "Choose a project"
                      : `${project.title} — ${environmentLabels.get(project.environmentId) ?? project.environmentId}`}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {`${candidate.title} — ${environmentLabels.get(candidate.environmentId) ?? candidate.environmentId}`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>

            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-title">
              Title
              <Input
                nativeInput
                id="calendar-title"
                maxLength={120}
                value={title}
                placeholder="Daily review"
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError(null);
                }}
              />
            </Label>

            <div className="grid grid-cols-2 gap-3">
              <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-date">
                Start date
                <Input
                  nativeInput
                  id="calendar-date"
                  type="date"
                  value={date}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
              <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-time">
                Start time
                <Input
                  nativeInput
                  id="calendar-time"
                  type="time"
                  value={time}
                  onChange={(event) => {
                    setTime(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
            </div>

            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-repeat">
              Repeat
              <Select
                value={repeat}
                onValueChange={(value) => {
                  setRepeat(value as CalendarRepeat);
                  setError(null);
                }}
              >
                <SelectTrigger id="calendar-repeat" aria-label="Repeat">
                  <SelectValue>
                    {CALENDAR_REPEAT_OPTIONS.find((option) => option.value === repeat)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {CALENDAR_REPEAT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>

            {repeat === "custom" ? (
              <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-cron">
                Cron expression
                <Input
                  nativeInput
                  id="calendar-cron"
                  maxLength={120}
                  value={customCron}
                  placeholder="0 16 * * 1-5"
                  onChange={(event) => {
                    setCustomCron(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
            ) : null}

            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-mode">
              Mode
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as CalendarEventMode);
                  setError(null);
                }}
              >
                <SelectTrigger id="calendar-mode" aria-label="Mode">
                  <SelectValue>
                    {CALENDAR_MODE_OPTIONS.find((option) => option.value === mode)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {CALENDAR_MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>

            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor="calendar-message">
              Message
              <Textarea
                id="calendar-message"
                value={message}
                placeholder="Prepare the daily status summary and post it here."
                onChange={(event) => {
                  setMessage(event.target.value);
                  setError(null);
                }}
              />
            </Label>

            <p className="text-xs text-muted-foreground">
              {cronValid
                ? `cron ${cron}${nextFire !== null ? ` · next ${formatDayLabel(nextFire)} ${nextFire.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}`
                : "Enter a repeat that produces a valid five-field cron expression."}
            </p>
            {wiring === "unwired" ? (
              <p className="text-xs text-warning-foreground">
                Saving is pending server wiring: the event is kept in this browser only.
              </p>
            ) : null}
            {error !== null ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
