import type { SettingsSearchItem } from "~/components/settings/settingsSearch";

/** Search entries for the fork-owned General settings sections. */
export const FT3_SETTINGS_SEARCH_ITEMS = [
  {
    id: "coordinator-board-nudge",
    title: "Nudge idle coordinators toward board cards",
    to: "/settings/general",
    searchTerms: ["coordinator board cards automatically idle take work autonomous"],
    scope: "environment-defaults",
  },
  {
    id: "coordinator-board-nudge-interval",
    title: "Minutes between coordinator board checks",
    to: "/settings/general",
    targetId: "coordinator-board-nudge",
    searchTerms: ["coordinator board nudge interval frequency"],
    scope: "environment-defaults",
  },
  {
    id: "coordinator-board-nudge-threshold",
    title: "Active child tasks that count as busy",
    to: "/settings/general",
    targetId: "coordinator-board-nudge",
    searchTerms: ["coordinator board nudge threshold child tasks busy"],
    scope: "environment-defaults",
  },
  {
    id: "board-retention",
    title: "Archive finished board cards automatically",
    to: "/settings/general",
    searchTerms: ["coordinator board archive retention delete finished done history"],
    scope: "environment-defaults",
  },
  {
    id: "board-retention-archive-after",
    title: "Days before a finished card is archived",
    to: "/settings/general",
    targetId: "board-retention",
    searchTerms: ["coordinator board archive days finished automatic"],
    scope: "environment-defaults",
  },
  {
    id: "board-retention-delete-after",
    title: "Days before an archived finished card is deleted",
    to: "/settings/general",
    targetId: "board-retention",
    searchTerms: ["coordinator board delete retention archived days history permanent"],
    scope: "environment-defaults",
  },
  {
    id: "deleted-thread-purge",
    title: "Erase deleted threads automatically",
    to: "/settings/general",
    searchTerms: ["thread delete retention erase purge permanent startup"],
    scope: "environment-defaults",
  },
  {
    id: "deleted-thread-purge-after",
    title: "Days before a deleted thread is erased",
    to: "/settings/general",
    targetId: "deleted-thread-purge",
    searchTerms: ["thread delete days erased purge permanent startup"],
    scope: "environment-defaults",
  },
] as const satisfies readonly SettingsSearchItem[];

export type Ft3SettingsSearchItemId = (typeof FT3_SETTINGS_SEARCH_ITEMS)[number]["id"];

const FT3_SEARCH_ITEMS_BY_ID = new Map(
  FT3_SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const),
);

export function ft3SearchableSetting(id: Ft3SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = FT3_SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}
