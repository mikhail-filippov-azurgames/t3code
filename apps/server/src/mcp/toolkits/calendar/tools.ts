import {
  CalendarCreateInput,
  CalendarCreateResult,
  CalendarDeleteInput,
  CalendarDeleteResult,
  CalendarError,
  CalendarListResult,
  CalendarUpdateInput,
  CalendarUpdateResult,
  McpCapabilityUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as CalendarEvents from "../../../persistence/Services/CalendarEvents.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  CalendarEvents.CalendarEventRepository,
];

/** Repeated in every write tool so the model cannot miss the skill's bans. */
const REGISTER_BANS =
  "Never create, edit, or delete an event without an explicit human request and a confirmed placement: never guess or silently change timeZone, never auto-renew, and never chain one scheduled run into another.";

export const CalendarToolError = Schema.Union([McpCapabilityUnavailableError, CalendarError]);
export type CalendarToolError = typeof CalendarToolError.Type;

const CalendarListTool = Tool.make("calendar_list", {
  description:
    "List every scheduled calendar event with its cron expression, IANA timeZone, computed nextFireAt, run history, and the thread a continue-mode event has been bound to. Read-only.",
  success: CalendarListResult,
  failure: CalendarToolError,
  dependencies,
})
  .annotate(Tool.Title, "List calendar events")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CalendarCreateTool = Tool.make("calendar_create", {
  description: `Create a scheduled calendar event that fires a prepared message into a thread on a local-time cron schedule. ${REGISTER_BANS} cronExpression is five whitespace-separated fields (minute hour day-of-month month day-of-week) in the event's IANA timeZone wall clock; seconds and @macros are unsupported and day-of-week accepts 0 or 7 for Sunday. mode new-thread starts a fresh thread on every fire; continue creates the thread on the first fire and reuses it afterwards. Returns the stored event with its computed nextFireAt.`,
  parameters: CalendarCreateInput,
  success: CalendarCreateResult,
  failure: CalendarToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create calendar event")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CalendarUpdateTool = Tool.make("calendar_update", {
  description: `Replace a scheduled calendar event's editable fields (title, message, mode, cronExpression, timeZone, modelSelection, runtimeMode, interactionMode). The event's project, run history, and bound thread are kept; changing cronExpression or timeZone recomputes nextFireAt from now. ${REGISTER_BANS}`,
  parameters: CalendarUpdateInput,
  success: CalendarUpdateResult,
  failure: CalendarToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update calendar event")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CalendarDeleteTool = Tool.make("calendar_delete", {
  description: `Delete a scheduled calendar event, cancelling every future fire. This removes the event and its run history; it is a cancel, not a pause. ${REGISTER_BANS}`,
  parameters: CalendarDeleteInput,
  success: CalendarDeleteResult,
  failure: CalendarToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete calendar event")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CalendarToolkit = Toolkit.make(
  CalendarListTool,
  CalendarCreateTool,
  CalendarUpdateTool,
  CalendarDeleteTool,
);
