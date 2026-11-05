import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BoardListResult } from "./contracts.ts";

const decodeBoardList = Schema.decodeUnknownSync(BoardListResult);

describe("BoardListResult", () => {
  it("decodes a board.list from a server that predates plans as having none", () => {
    assert.deepStrictEqual(decodeBoardList({ cards: [], events: [] }), {
      cards: [],
      events: [],
      plans: [],
    });
  });
});
