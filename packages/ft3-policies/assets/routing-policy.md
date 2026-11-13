---
revision: 1
---

# Routing policy

The lead selects the role and task level. The server resolves them to the ordered
candidates below. Connect Zavod before creating mail participants.

## Cells

| Role                       | low   | medium | high  | very-high |
| -------------------------- | ----- | ------ | ----- | --------- |
| `architect`, `architect-*` | O → S | O → S  | O → S | O → S     |
| `implementation`           | L → N | N → S  | S → O | S → O     |
| `review-claude`            | S → O | S → O  | S → O | S → O     |
| `review-codex`             | O → S | O → S  | O → S | O → S     |
| `review-*`                 |       |        |       |           |
| `test`                     | L → N | N → S  | S → O | S → O     |
| `research`                 | L → N | L → N  | S     | S         |
| `general`                  | L → N | L → N  | S     | S         |
| `planner`                  | O → S | O → S  | O → S | O → S     |

The human starts the lead with Claude Opus 5.5 through Zavod.
For review of a Claude implementation, choose role `review` with specialization `claude`.
For review of a Codex implementation, choose role `review` with specialization `codex`.
The first candidate uses the other model family. The second candidate is the fallback.
A review participant needs one of these specializations to receive a route.

## Aliases

An alias uses the options of the task level. `alias@level` pins the model options
to the named level. Each provider heading names its instance ID and driver kind.

### Codex through Zavod (`zavod-codex / codex`)

| Alias | model         | low                   | medium                   | high                   | very-high               |
| ----- | ------------- | --------------------- | ------------------------ | ---------------------- | ----------------------- |
| S     | `gpt-6.1-sol` | `reasoningEffort=low` | `reasoningEffort=medium` | `reasoningEffort=high` | `reasoningEffort=xhigh` |
| L     | `gpt-6-luna`  | `reasoningEffort=max` | `reasoningEffort=max`    | `reasoningEffort=max`  | `reasoningEffort=max`   |

### Claude through Zavod (`zavod-claude / claudeAgent`)

| Alias | model               | low             | medium        | high            | very-high     |
| ----- | ------------------- | --------------- | ------------- | --------------- | ------------- |
| O     | `claude-opus-5-5`   | `effort=low`    | `effort=low`  | `effort=medium` | `effort=high` |
| N     | `claude-sonnet-5-5` | `effort=medium` | `effort=high` | `effort=high`   | `effort=high` |

## Service mode

All candidates use normal service. Codex uses `serviceTier=default` and Claude
uses `fastMode=false`. Only the managed Zavod instances above are routing targets.
An empty candidate chain produces a no-candidate result for the lead.
