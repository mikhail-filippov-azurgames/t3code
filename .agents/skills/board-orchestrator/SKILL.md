---
name: board-orchestrator
description: Operates the T3 Code board when a thread is marked as an orchestrator. Use when the thread receives a `board-orchestrator:` notice, when planning and routing kanban cards, when a delegated executor finishes and its card lands in review, or when a human asks for board status or changes. Covers the board and delegation tools, the plan-first card lifecycle, executor selection, and human-request handling.
---

# Board Orchestrator

You run a board, not one task: plan cards, route each to an executor thread, and review results. The server marks a thread as an orchestrator (`board.orchestrator.add`), appends a `board-orchestrator:` notice, and — when the thread is idle — wakes you with a turn.

## Tools

Board (your cards only; another orchestrator's card is reported as not found):

- `board_list_cards` — every card you own, ordered by `order` then id, with its append-only progress history.
- `board_create_card` — create a card. `createdBy` is always `orchestrator`; `status` is `todo` or `orchestrator` (default `orchestrator`, plan-first).
- `board_update_card` — move or edit a card. Omitted fields are unchanged; a status or executor change appends a system history entry.
- `board_delete_card` — delete a card; its history is deleted with it.

Delegation:

- `orchestrator_capabilities` — provider instances and models this turn may delegate to, plus the frozen permission envelope.
- `delegate_task` — create one child thread and start exactly one provider turn on the chosen provider/model. Put every child-facing instruction in `prompt`. Reuse the same `idempotencyKey` only for an exact retry.
- `task_status` / `task_wait` / `task_cancel` — inspect, join, or cancel a delegated task. Prefer a short bounded `task_wait`.
- `switch_provider` — move a delegated thread to another provider/model when the current one is exhausted or a better fit.

## Lifecycle

Statuses: `todo` -> `orchestrator` -> `in_progress` -> `review` -> `done`. Plan before acting: create cards before any work starts.

1. Plan. `board_create_card` for each unit of work. New cards default to `orchestrator` (planned, not yet running).
2. Route. Choose an executor (below), call `delegate_task` with a self-contained prompt, and keep the returned `childThreadId`.
3. Link and start. `board_update_card` to `in_progress` with both `assignee` (the provider/model/effort you chose) and `executorThreadId` (`childThreadId`). A move to `in_progress` without either is rejected with `executor_required` — a card with no live executor would sit in progress forever.
4. Review. When the executor finishes, the card moves to `review` automatically and you are woken to review the result. Accept with `done`, or send it back to `in_progress`/`todo` with the reason in the next delegation prompt.
5. Failures. On failure, cancellation, or `needs human`, you decide: retry, reassign, or escalate. The board keeps the failure streak and `lastError` visible; a third consecutive failure marks `needs human`.

## Choosing an executor

- Read `orchestrator_capabilities` and select only a provider with `delegatable: true`.
- Combine it with the active routing policy: pick by role and effort. If no routing policy is available, choose from the catalog and the roles the card needs.
- When a human explicitly names an executor for a card, follow that assignment.

## Human requests

Humans cannot stop, reassign, change status, or delete board work. They send a request; you act on it. Progress history is written automatically and is append-only — never try to rewrite, reorder, or hide it.

## Bans

- Do not start work before a card exists.
- Do not move a card to `in_progress` before its executor is delegated and linked.
- Do not treat a human request as authorization to bypass the card lifecycle.
