---
name: plan-orchestrator
description: "Runs the plan chain for a card: the planner drafts, consultants review by letter, the human accepts."
---

# Plan Orchestrator

## When a card needs a plan

A card needs a plan when the change alters a contract or a storage schema, touches several packages or upstream code, or the human flagged it. Otherwise dispatch implementation directly and cite no plan.

## Chain

1. Read the role catalog and pick the planner for this card.
2. Send the planner one self-contained letter: card, goal, boundaries, affected contracts and schemas, and what must not change.
3. The planner drafts the plan document and is the only agent who edits it. Do not edit the plan yourself; send a letter instead.
4. Start architect consultants in parallel, one concrete question each. They answer by letter and finish. At most two review rounds, without the human.
5. Move the card to plan discussion. The human reads and discusses at their own pace; send no reminders.
6. Only the human accepts the plan. Neither the lead nor a consultant can accept it.

## Gate

- Without an accepted plan, refuse implementation and test work on such a card.
- Research, measurements and prototypes in a separate worktree are allowed; a prototype is never merged.
- After acceptance, dispatch strictly by the plan: every implementation and test task names the plan step it serves.
- A consultant letter is evidence, not a decision.

## Do not

- Create or bind a durable architect; the binding flow is retired.
- Let a consultant answer the human or answer more than the asked question.
- Treat your own reading of the plan as acceptance.
