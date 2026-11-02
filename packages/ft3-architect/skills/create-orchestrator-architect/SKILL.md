---
name: create-orchestrator-architect
description: Creates or reuses the single Architect bound to a lead thread via architect_create_or_get (never delegate_task). Use when a lead needs long-horizon architecture review with a durable binding, ordered credential revocation, and publish-only wake.
---

# Create Orchestrator Architect

Thin wrapper over `architect_create_or_get`. Never create an architect with `delegate_task` — that mints an executor lineage, not a binding, and executor denies will reject every architect and review call.

## Workflow

1. Resolve the lead: the lead thread id you run on (or the human operates). Only the lead thread itself, or a human on it, may call architect tools.
2. Check the binding: call `get_lead_binding` with the lead thread id. An `active` binding means an architect already exists — reuse it, do not create a second one.
3. Resolve the model from the routing policy whose reference is given in the brief. Read its current accepted revision from the policy itself, not pinned here, using the lead-selected `taskEffort` (`low` | `medium` | `high` | `very-high`). Read the policy again before changing routing.
4. Call `architect_create_or_get` with `coordinatorThreadId`, `taskEffort`, the exact policy-selected `modelSelection`, and an idempotency key. Same key replays the same binding; a different key with the same lead returns the existing active binding.
5. Bootstrap the architect with compact explicit-ref context (binding id, review flow, read-only caps). Keep it short: refs, not transcripts.
6. Verify: the architect thread carries control-plane role `architect`, sees only its own binding, and runs under the frozen read-only capability envelope.
7. Return: the architect thread link, provider/model, and binding state (`active`, binding id).

The routing policy referenced in the brief is authoritative for the alias table and fallback order: take the primary alias from its target table, and only when it is ineligible walk its fallback pool in order, skipping any alias already considered. Do not copy that table into this skill — read the policy itself. Do not infer a provider, model, option value, or default from task effort. Eligibility requires the live catalog, valid live option values, the required read-only permission envelope, and an enabled provider. Record every considered candidate and its reason; `routingEvidence` must end with the selected candidate.

Do not trust cached provider state: verify provider instance, driver, model, option values, and permission envelope against the live catalog immediately before creating or replacing a binding. A human's sidebar model choice is a preference; reject it or explain the policy fallback if it is not eligible. Record the routing decision and rationale before calling create or replace.

## Rules the skill must state back

- Soft-delete only: `architect_replace` and `architect_detach` mark the binding `replaced`/`detached` and revoke the architect credential in order (durable commit first, revocation receipt after). Detached bindings are retained, never resurrected, never purged.
- Lead wakes from the Architect side: `publish_to_lead` by the Architect for lead requests, and the human Publish button for any answered record. Ordinary user↔Architect conversation never wakes the lead; answers alone never wake it. Publication is exactly once per review, proven by a wake-delivered marker.
- Unrequested advice: call `prepare_lead_publication`; it never wakes the lead and replaces the previous unpublished preparation. Tell the human to inspect it in the Architect composer and press the Publish button.
- Reviews: `architecture_review_request` needs an explicit `executionPosture` (`continue` | `pause-branch` | `pause-all`, no default). Answers carry a required `answerDisposition`. First answer wins; reusing an answer key with a different payload returns `idempotency_conflict`.
- Queries: the lead/human may query the lead binding and reviews; the bound Architect may query its own binding and reviews only.
- Denies: executors get `architect_denied` on all nine architect/review tools. A stale architect credential after detach fails the durable binding check.
- Sidebar Ask/Replace/Detach controls draft a lead instruction. The lead must still call the authorized tool; Replace requires the selected model and reason to be recorded and confirmed before execution.
