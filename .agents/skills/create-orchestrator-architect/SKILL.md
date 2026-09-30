---
name: create-orchestrator-architect
description: Creates or reuses the single Architect bound to a coordinator thread via architect_create_or_get (never delegate_task). Use when a coordinator needs long-horizon architecture review with a durable binding, ordered credential revocation, and publish-only wake.
---

# Create Orchestrator Architect

Thin wrapper over `architect_create_or_get`. Never create an architect with `delegate_task` — that mints an executor lineage, not a binding, and executor denies will reject every architect and review call.

## Workflow

1. Resolve the coordinator: the coordinator thread id you run on (or the human operates). Only the coordinator thread itself, or a human on it, may call architect tools.
2. Check the binding: call `get_coordinator_binding` with the coordinator thread id. An `active` binding means an architect already exists — reuse it, do not create a second one.
3. Resolve the model from the accepted policy `oc://doc/3900df61-9dd5-4621-9278-34ac20d60648` (its current accepted revision is read from OpenContext, not pinned here), using the coordinator-selected `taskEffort` (`low` | `medium` | `high` | `very-high`). Read the policy again before changing routing.
4. Call `architect_create_or_get` with `coordinatorThreadId`, `taskEffort`, the exact policy-selected `modelSelection`, and an idempotency key. Same key replays the same binding; a different key with the same coordinator returns the existing active binding.
5. Bootstrap the architect with compact explicit-ref context (binding id, review flow, read-only caps). Keep it short: refs, not transcripts.
6. Verify: the architect thread carries control-plane role `architect`, sees only its own binding, and runs under the frozen read-only capability envelope.
7. Return: the architect thread link, provider/model, and binding state (`active`, binding id).

The accepted routing policy in OpenContext is authoritative for the alias table and fallback order: take the primary alias from its §1 target table, and only when it is ineligible walk its §4 fallback pool in order, skipping any alias already considered. Do not copy that table into this skill — read the policy document itself. Do not infer a provider, model, option value, or default from task effort. Eligibility requires the live catalog, valid live option values, the required read-only permission envelope, and an enabled provider. Record every considered candidate and its reason; `routingEvidence` must end with the selected candidate.

Do not trust cached provider state: verify provider instance, driver, model, option values, and permission envelope against the live catalog immediately before creating or replacing a binding. A human's sidebar model choice is a preference; reject it or explain the policy fallback if it is not eligible. Save the routing decision and rationale to OpenContext before calling create or replace.

## Rules the skill must state back

- Soft-delete only: `architect_replace` and `architect_detach` mark the binding `replaced`/`detached` and revoke the architect credential in order (durable commit first, revocation receipt after). Detached bindings are retained, never resurrected, never purged.
- Publish-only wake: review answers never wake the coordinator. Only `publish_to_coordinator` wakes it, exactly once per review, proven by a wake-delivered marker.
- Reviews: `architecture_review_request` needs an explicit `executionPosture` (`continue` | `pause-branch` | `pause-all`, no default). Answers carry a required `answerDisposition`. First answer wins; reusing an answer key with a different payload returns `idempotency_conflict`.
- Queries: the coordinator/human may query the coordinator binding and reviews; the bound Architect may query its own binding and reviews only.
- Denies: executors get `architect_denied` on all nine architect/review tools. A stale architect credential after detach fails the durable binding check.
- Sidebar Ask/Replace/Detach controls draft a Coordinator instruction. The Coordinator must still call the authorized tool; Replace requires the selected model and reason to be recorded in OpenContext and confirmed before execution.
