---
name: board-orchestrator
description: "Operates the kanban board for lead threads: plan-first cards, status transitions and human escalation."
---

# Board Orchestrator

## When to apply

Apply when creating, listing, updating or deleting board cards, delegating card executors, or handling a failure wake on a card.

## Plan first

- Cards are created before executor threads start, and the plan is the observable artifact: delegation follows the plan, never precedes it.
- A card belongs to one lead thread. A child thread cannot own cards.
- The human creates cards in `todo`; a card the lead creates starts in its orchestrator state.

## Statuses

Statuses are `todo | orchestrator | in_progress | review | done`. `done` is terminal; there is no reopen. Every transition appends a progress-history record without a model call.

| From -> To                      | Trigger                      | Side effect                                       |
| ------------------------------- | ---------------------------- | ------------------------------------------------- |
| `todo` -> `orchestrator`        | human start                  | lead turn starts when idle                        |
| `orchestrator` -> `in_progress` | delegation links an executor | card records the assignee and executor thread     |
| `in_progress` -> `review`       | executor success             | lead wake with card context                       |
| `in_progress` -> `in_progress`  | executor failure             | failure recorded, failure streak grows, lead wake |
| `review` -> `done`              | lead accepts                 | card closes                                       |
| `review` -> `in_progress`       | lead reworks                 | new or same executor, failure streak reset        |

## Failure and escalation

- A terminal executor failure is never lost and never becomes a success.
- After repeated failures the card is marked as needing the human; retry, reassign and stop stay with the lead.
- A failure wake is durable: if the lead is unavailable, the turn starts later. Do not fabricate a success from a missing event.

## Prohibitions

- Do not edit or delete individual progress-history records.
- Do not create a second board for the same workflow.
- Do not move a card to `in_progress` without both an assignee and an executor thread.
