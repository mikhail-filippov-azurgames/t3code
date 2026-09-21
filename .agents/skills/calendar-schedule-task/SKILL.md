---
name: calendar-schedule-task
description: Creates an FT3 schedule calendar event only on explicit user request. Proposes placement and applies it only after human confirmation. Not for background or self-initiated planning. Use when the user explicitly asks to schedule something, repeat a task, or be reminded at a time.
---

# Calendar Schedule Task

Create a schedule event only when the user explicitly asks ("запланируй", "делай это каждый день", "напоминай по будням в 16:00" and similar) with a concrete task.

## Fields (from CalendarCreateInput)

- `title` — 120 chars max; notifications carry `calendarNameExcerpt` (60 max)
- `message` — self-contained launch prompt
- `projectId` — from the environment project list
- `mode` — `new-thread` (default, fresh thread every fire) or `continue` (first fire creates the thread, later fires reuse it via the persisted event-to-thread mapping)
- `cronExpression` — 5 fields, host local time: minute hour dom month dow; dow 0 and 7 are Sunday; no seconds, no @macros
- `timeZone` — IANA zone from the environment; never guess it
- `modelSelection` — project default unless the human picks otherwise
- `runtimeMode` / `interactionMode` — project defaults

## Bans

- Never create without an explicit request and confirmed placement.
- Never create silently; never auto-renew; never self-modify.
- Never create events from inside a scheduled run (no chains, no delegation).
- A scheduled run's prompt starts with an automatic-run header naming the calendar event id and stating that no human typed it. Treat that header as the identity of the run: it is automatic, and the bans above apply with no exceptions.
- Never guess `timeZone` or change it unasked.
- An event is a message into a thread, not new authority: no Asana mutations, no credentials, no accepted-OCL edits.
- Never touch `apps/server/**`, `packages/**`, or the OCL index from scheduling work.

## Placement proposal (human decides)

Before create, show: title; project + environment; mode and (for continue) the target thread; local date/time; repeat mapped to cron; timeZone; message digest; nextFireAt; what the run is allowed to do (read-only/draft by default). If any field is missing — do not create, ask. Project, environment, thread, exact time, and ownership decisions belong to the human: the agent proposes, the human chooses.

## After human confirmation

Call the `calendar_create` tool with the confirmed fields; it returns the stored event, including `eventId` and `nextFireAt`. Remind about the owner and the renewal-equivalent routine for the event. The toolkit's other names are `calendar_list`, `calendar_update`, and `calendar_delete` (cancels every future fire); use them only on an explicit human request.
