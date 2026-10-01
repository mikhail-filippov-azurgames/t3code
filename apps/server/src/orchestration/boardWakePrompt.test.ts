import { assert, describe, it } from "@effect/vitest";
import { BOARD_ORCHESTRATOR_TURN_TEXT } from "./boardWakePrompt.ts";

describe("Coordinator board brief", () => {
  it("identifies the Coordinator and preserves board ownership duties", () => {
    assert.include(BOARD_ORCHESTRATOR_TURN_TEXT, "You are the Coordinator for this board thread");
    assert.notInclude(BOARD_ORCHESTRATOR_TURN_TEXT, "You were marked as the orchestrator");
    for (const responsibility of [
      "board_list_cards",
      "Manage cards through the board tools",
      "create precise cards",
      "Communicate with the human and executors",
      "route work with delegate_task",
      "Supervise delegated work",
      "review each completed executor result",
      "retry, reassign, or escalate",
    ]) {
      assert.include(BOARD_ORCHESTRATOR_TURN_TEXT, responsibility);
    }
  });

  it("requires the exact Architect skill and one active binding before board work", () => {
    for (const requirement of [
      "Before taking any substantive board action",
      "create-orchestrator-architect",
      "get_coordinator_binding",
      "reuse its active Architect",
      "create/get the single bound Architect",
      "architect_create_or_get",
    ]) {
      assert.include(BOARD_ORCHESTRATOR_TURN_TEXT, requirement);
    }
    assert.include(
      BOARD_ORCHESTRATOR_TURN_TEXT,
      "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648 to choose the Architect provider and model",
    );
    assert.include(
      BOARD_ORCHESTRATOR_TURN_TEXT,
      "read that policy's current accepted revision from OpenContext",
    );
    assert.notInclude(BOARD_ORCHESTRATOR_TURN_TEXT, "3900df61-9dd5-4621-9278-34ac20d60648@");
    assert.notInclude(BOARD_ORCHESTRATOR_TURN_TEXT, "gpt-6-");
    assert.notInclude(BOARD_ORCHESTRATOR_TURN_TEXT, "muse-spark");
  });

  it("keeps Architect advice separate from Coordinator decisions and supervision", () => {
    for (const boundary of [
      "architecture choices",
      "cross-cutting design",
      "decomposition with architectural consequences",
      "difficult root-cause or plan review",
      "not an executor or a second Coordinator",
      "you decide and remain responsible for board state, executor prompts, communication with the human, and execution supervision",
    ]) {
      assert.include(BOARD_ORCHESTRATOR_TURN_TEXT, boundary);
    }
  });

  it("requires causes to be shown by observable facts before being reported", () => {
    for (const requirement of [
      "Do not report a cause as a fact until it is shown by an observable fact",
      "Separate what was observed from what was inferred",
      "label an inference as an inference",
    ]) {
      assert.include(BOARD_ORCHESTRATOR_TURN_TEXT, requirement);
    }
  });
});
