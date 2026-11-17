import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_ZAVOD_403_MODEL_ACCESS,
  CLAUDE_ZAVOD_UNREACHABLE,
  CODEX_ZAVOD_429,
  CODEX_ZAVOD_503_AUTH_UNAVAILABLE,
  type ZavodErrorFixture,
} from "./__fixtures__/zavod-errors.ts";
import { classifyZavodFailure, isZavodInstanceId } from "./failure.ts";

const classify = (fixture: ZavodErrorFixture, instanceId = fixture.instanceId) =>
  classifyZavodFailure({ ...fixture, instanceId });

describe("isZavodInstanceId", () => {
  it("accepts only the fixed Zavod ids", () => {
    for (const id of ["claudeZavod", "codexZavod", "zavod-claude", "zavod-codex"]) {
      expect(isZavodInstanceId(id)).toBe(true);
    }
    for (const id of ["claudeAgent", "codex", "zavod", "ClaudeZavod", "", null, undefined]) {
      expect(isZavodInstanceId(id)).toBe(false);
    }
  });
});

describe("classifyZavodFailure", () => {
  it.each([
    [CODEX_ZAVOD_503_AUTH_UNAVAILABLE, "transient"],
    [CODEX_ZAVOD_429, "rate_limited"],
    [CLAUDE_ZAVOD_403_MODEL_ACCESS, "model_access_denied"],
    [CLAUDE_ZAVOD_UNREACHABLE, "unavailable"],
  ] as const)("classifies a recorded Zavod failure (%#)", (fixture, kind) => {
    expect(classify(fixture)).toBe(kind);
  });

  it.each([
    CODEX_ZAVOD_503_AUTH_UNAVAILABLE,
    CODEX_ZAVOD_429,
    CLAUDE_ZAVOD_403_MODEL_ACCESS,
    CLAUDE_ZAVOD_UNREACHABLE,
  ])("returns null for the same failure on a personal instance (%#)", (fixture) => {
    expect(classify(fixture, "claudeAgent")).toBeNull();
    expect(classify(fixture, "codex")).toBeNull();
  });

  it("returns null for an unrelated failure on a Zavod instance", () => {
    expect(
      classifyZavodFailure({
        instanceId: "claudeZavod",
        errorClass: "validation_error",
        errorCode: "invalid_request",
        message: "Prompt is too long",
      }),
    ).toBeNull();
  });

  it("recognizes the code-only and class-only signals", () => {
    const base = { instanceId: "zavod-codex", errorClass: null, errorCode: null, message: "" };
    expect(classifyZavodFailure({ ...base, errorCode: "team_model_access_denied" })).toBe(
      "model_access_denied",
    );
    expect(classifyZavodFailure({ ...base, errorCode: "api_error_429" })).toBe("rate_limited");
    expect(classifyZavodFailure({ ...base, errorClass: "usage_limit" })).toBe("rate_limited");
    expect(classifyZavodFailure({ ...base, message: "getaddrinfo ENOTFOUND zavod" })).toBe(
      "unavailable",
    );
    expect(classifyZavodFailure({ ...base, message: "TypeError: fetch failed" })).toBe(
      "unavailable",
    );
  });
});
