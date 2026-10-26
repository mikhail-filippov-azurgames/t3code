import * as Schema from "effect/Schema";

export const CommitGraphColumn = Schema.Literals(["commit", "author", "date"]);
export type CommitGraphColumn = typeof CommitGraphColumn.Type;

export const CommitGraphDateFormat = Schema.Literals(["datetime", "date", "relative"]);
export type CommitGraphDateFormat = typeof CommitGraphDateFormat.Type;

export const DEFAULT_COMMIT_GRAPH_COLUMNS: ReadonlyArray<CommitGraphColumn> = [
  "commit",
  "author",
  "date",
];

export const COMMIT_GRAPH_PREFERENCES_KEY = "t3code:commits-graph-preferences:v1";

export const CommitGraphPreferencesSchema = Schema.Struct({
  columns: Schema.mutable(Schema.Array(CommitGraphColumn)),
  dateFormat: CommitGraphDateFormat,
});

export type CommitGraphPreferences = typeof CommitGraphPreferencesSchema.Type;

export const DEFAULT_COMMIT_GRAPH_PREFERENCES = {
  columns: [...DEFAULT_COMMIT_GRAPH_COLUMNS],
  dateFormat: "datetime",
} satisfies CommitGraphPreferences;
