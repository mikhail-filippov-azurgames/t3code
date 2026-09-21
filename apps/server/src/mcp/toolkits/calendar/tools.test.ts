import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { CalendarToolkit } from "./tools.ts";

it("exposes exactly the calendar read and write surface", () => {
  expect(Object.keys(CalendarToolkit.tools)).toEqual([
    "calendar_list",
    "calendar_create",
    "calendar_update",
    "calendar_delete",
  ]);
});

it("keeps every tool honest about the human-request ban", () => {
  for (const tool of Object.values(CalendarToolkit.tools)) {
    expect(
      tool.description?.length ?? 0,
      `${tool.name} needs a useful description`,
    ).toBeGreaterThan(40);
    if (tool.name !== "calendar_list") {
      expect(tool.description, `${tool.name} must carry the create/edit/delete ban`).toContain(
        "Never create, edit, or delete an event without an explicit human request",
      );
    }
  }
});

it("declares the create fields from the contract", () => {
  const schema = Tool.getJsonSchema(CalendarToolkit.tools.calendar_create) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
    "cronExpression",
    "interactionMode",
    "message",
    "mode",
    "modelSelection",
    "projectId",
    "runtimeMode",
    "timeZone",
    "title",
  ]);
});

it("marks each tool read-only, destructive, and idempotent where it is", () => {
  const list = CalendarToolkit.tools.calendar_list;
  const create = CalendarToolkit.tools.calendar_create;
  const update = CalendarToolkit.tools.calendar_update;
  const remove = CalendarToolkit.tools.calendar_delete;
  expect(Context.get(list.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(create.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(create.annotations, Tool.Idempotent)).toBe(false);
  expect(Context.get(update.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(remove.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(remove.annotations, Tool.OpenWorld)).toBe(false);
});
