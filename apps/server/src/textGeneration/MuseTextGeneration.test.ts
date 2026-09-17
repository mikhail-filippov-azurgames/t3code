import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TextGenerationError } from "@t3tools/contracts";

import { decodeMuseJsonOutput } from "./MuseTextGeneration.ts";

const TitleSchema = Schema.Struct({ title: Schema.String });

describe("decodeMuseJsonOutput", () => {
  it.effect("decodes a plain JSON object", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeMuseJsonOutput(
        "generateThreadTitle",
        TitleSchema,
        `{"title": "Fix login race"}`,
      );

      expect(decoded).toEqual({ title: "Fix login race" });
    }),
  );

  it.effect("unwraps fenced output", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeMuseJsonOutput(
        "generateThreadTitle",
        TitleSchema,
        '```json\n{"title": "Fix login race"}\n```',
      );

      expect(decoded).toEqual({ title: "Fix login race" });
    }),
  );

  it.effect("fails closed on non-JSON output", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decodeMuseJsonOutput("generateThreadTitle", TitleSchema, "no json here"),
      );

      expect(failure).toBeInstanceOf(TextGenerationError);
    }),
  );
});
