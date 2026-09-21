/**
 * Create/edit form for a scheduled event.
 *
 * The contract has no explicit datetime field: the chosen local start instant
 * and repeat compose the stored cron expression. The executor (provider
 * instance, model and its options such as reasoning effort) is chosen here and
 * sent as `modelSelection`; it defaults to the chosen project's resolved
 * settings the same way a new thread picks its default. Editing pre-fills from
 * the event and sends only the editable fields.
 *
 * @module components/calendar/CalendarEventDialog
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type CalendarCreateInput,
  type CalendarEvent,
  type CalendarEventMode,
  type CalendarUpdateInput,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useMemo, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { type CalendarTransport } from "../../state/calendar";
import { useEnvironments } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
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
  browserTimeZone,
  CALENDAR_MODE_OPTIONS,
  CALENDAR_REPEAT_OPTIONS,
  composeCron,
  formatClock,
  formatDayLabel,
  inferCalendarRepeat,
  nextCronOccurrence,
  parseCron,
  type CalendarRepeat,
} from "./calendar.logic";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultStart(): { date: string; time: string } {
  const next = new Date();
  next.setMinutes(Math.ceil((next.getMinutes() + 30) / 15) * 15, 0, 0);
  return {
    date: formatLocalDate(next),
    time: `${pad(next.getHours())}:${pad(next.getMinutes())}`,
  };
}

/** Pre-fill the date and time from the event's next fire so its cron round-trips. */
function startFromCron(expression: string): { date: string; time: string } {
  const next = nextCronOccurrence(expression, new Date());
  if (next === null) return defaultStart();
  return {
    date: formatLocalDate(next),
    time: `${pad(next.getHours())}:${pad(next.getMinutes())}`,
  };
}

function parseStart(date: string, time: string): Date | null {
  if (date.length === 0) return null;
  const parsed = new Date(`${date}T${time.length === 0 ? "00:00" : time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface CalendarEventDialogProps {
  readonly environmentId: EnvironmentId;
  readonly transport: CalendarTransport;
  readonly onClose: () => void;
  /** Present when editing an existing event; absent when creating one. */
  readonly event?: CalendarEvent | null;
  readonly onCreate: (input: CalendarCreateInput) => Promise<void>;
  readonly onUpdate: (input: CalendarUpdateInput) => Promise<void>;
}

export function CalendarEventDialog({
  environmentId,
  transport,
  onClose,
  event,
  onCreate,
  onUpdate,
}: CalendarEventDialogProps) {
  const editing = event != null;
  const serverConfigs = useServerConfigs();
  // The event is stored and fired by one environment's server, so only that
  // environment's projects can be its target.
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const { environments } = useEnvironments();
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );

  const initialStart = useMemo(
    () => (event != null ? startFromCron(event.cronExpression) : defaultStart()),
    [event],
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(
    event?.projectId ?? projects[0]?.id ?? null,
  );
  const [title, setTitle] = useState(event?.title ?? "");
  const [message, setMessage] = useState(event?.message ?? "");
  const [date, setDate] = useState(initialStart.date);
  const [time, setTime] = useState(initialStart.time);
  const [repeat, setRepeat] = useState<CalendarRepeat>(
    event != null ? inferCalendarRepeat(event.cronExpression) : "weekly",
  );
  const [customCron, setCustomCron] = useState(event?.cronExpression ?? "");
  const [mode, setMode] = useState<CalendarEventMode>(event?.mode ?? "new-thread");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const resolvedSettings =
    project === null
      ? null
      : resolveProjectSettings(
          serverConfigs.get(project.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
          project.id,
          project,
        ).settings;

  // The picker reads client-side preferences (hidden models, ordering) that the
  // server settings do not carry; defaults keep those empty for this form.
  const pickerSettings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...(resolvedSettings ?? DEFAULT_SERVER_SETTINGS),
  };
  const providers =
    (project === null ? undefined : serverConfigs.get(project.environmentId))?.providers ?? [];
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), pickerSettings),
  );
  const defaultModelSelection = resolveDefaultProviderModelSelection(
    providers,
    pickerSettings.defaultModelSelection,
  );
  // Null until the user picks an executor, so the project's resolved default
  // keeps applying while the form is untouched.
  const [modelSelectionOverride, setModelSelectionOverride] = useState<ModelSelection | null>(
    event?.modelSelection ?? null,
  );
  const modelSelection = modelSelectionOverride ?? defaultModelSelection;
  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === modelSelection?.instanceId) ?? null;
  const modelOptions = getCustomModelOptionsByInstance(
    pickerSettings,
    providers,
    modelSelection?.instanceId,
    modelSelection?.model,
  );

  const start = parseStart(date, time);
  const cron = start === null ? "" : composeCron(start, repeat, customCron);
  const cronValid = parseCron(cron) !== null;
  const nextFire = cronValid && start !== null ? nextCronOccurrence(cron, new Date()) : null;

  const submit = async () => {
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
    if (nextFire === null) {
      setError("This cron expression has no upcoming fire time.");
      return;
    }
    if (modelSelection === null) {
      setError("Choose an executor for the scheduled thread.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (event != null) {
        await onUpdate({
          eventId: event.eventId,
          title: title.trim(),
          message,
          mode,
          cronExpression: cron,
          timeZone: browserTimeZone(),
          modelSelection,
          runtimeMode: event.runtimeMode,
          interactionMode: event.interactionMode,
        });
      } else {
        await onCreate({
          projectId: project.id,
          title: title.trim(),
          message,
          mode,
          cronExpression: cron,
          timeZone: browserTimeZone(),
          modelSelection,
          runtimeMode:
            resolvedSettings?.defaultRuntimeMode ?? DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The server could not save this task.");
    } finally {
      setSubmitting(false);
    }
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
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
            <DialogDescription>
              A prepared message is delivered to a thread on a local-time schedule.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="calendar-project"
            >
              Project
              <Select
                value={projectId ?? ""}
                onValueChange={(value) => {
                  setProjectId(value as ProjectId);
                  // A different project resolves a different default executor.
                  setModelSelectionOverride(null);
                  setError(null);
                }}
              >
                <SelectTrigger id="calendar-project" aria-label="Project" disabled={editing}>
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
              <Label
                className="flex min-w-0 flex-col items-stretch gap-1.5"
                htmlFor="calendar-date"
              >
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
              <Label
                className="flex min-w-0 flex-col items-stretch gap-1.5"
                htmlFor="calendar-time"
              >
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

            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="calendar-repeat"
            >
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
              <div className="flex flex-col gap-1.5">
                <Label
                  className="flex min-w-0 flex-col items-stretch gap-1.5"
                  htmlFor="calendar-cron"
                >
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
                <p className="text-xs text-muted-foreground">
                  Five fields: minute hour day-of-month month day-of-week. Examples:{" "}
                  <code>0 * * * *</code> every hour, <code>*/15 * * * *</code> every 15 minutes,{" "}
                  <code>0 16 * * 1-5</code> weekdays at 16:00.
                </p>
              </div>
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

            <div className="flex min-w-0 flex-col items-stretch gap-1.5">
              <span className="text-sm font-medium">Executor</span>
              {modelSelection !== null && activeEntry !== null ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={modelSelection.instanceId}
                    model={modelSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptions}
                    triggerVariant="outline"
                    onInstanceModelChange={(instanceId, model) => {
                      setModelSelectionOverride(createModelSelection(instanceId, model));
                      setError(null);
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    models={activeEntry.models}
                    model={modelSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={modelSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={pickerSettings.planModeEnabled}
                    triggerVariant="outline"
                    onModelOptionsChange={(options) => {
                      setModelSelectionOverride(
                        createModelSelection(
                          modelSelection.instanceId,
                          modelSelection.model,
                          options,
                        ),
                      );
                      setError(null);
                    }}
                  />
                </div>
              ) : (
                <p className="text-xs text-warning-foreground">
                  No provider is available for this project. Choose a different project or set one
                  up in settings.
                </p>
              )}
            </div>

            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="calendar-message"
            >
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
                ? `cron ${cron}${nextFire !== null ? ` · next ${formatDayLabel(nextFire)} ${formatClock(nextFire)}` : ""}`
                : "Enter a repeat that produces a valid five-field cron expression."}
            </p>
            {transport !== "live" ? (
              <p className="text-xs text-warning-foreground">
                The calendar server is unavailable, so this task cannot be saved right now.
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
            <Button type="submit" disabled={transport !== "live" || submitting}>
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
