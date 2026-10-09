import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CommitGraphPreferencesSchema,
  DEFAULT_COMMIT_GRAPH_PREFERENCES,
} from "./commitsGraphPreferences";

describe("commit graph preferences", () => {
  it("defaults to title, short SHA, author and date-time", () => {
    expect(DEFAULT_COMMIT_GRAPH_PREFERENCES).toEqual({
      columns: ["commit", "author", "date"],
      dateFormat: "datetime",
    });
  });

  it("rejects unknown columns and date formats", () => {
    expect(
      Schema.decodeUnknownOption(CommitGraphPreferencesSchema)({
        columns: ["commit", "message"],
        dateFormat: "weekday",
      })._tag,
    ).toBe("None");
  });
});
