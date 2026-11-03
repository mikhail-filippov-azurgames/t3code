---
name: t3-orchestrator
description: "Coordinates durable child threads and independent specialist roles for multi-stage or parallel work."
---

# T3 Orchestrator

Coordinate durable child work. Keep task framing and final synthesis in the parent thread.

## Handoff

- Use durable child threads when work needs lineage, cross-provider execution or a separate session; an in-process agent cannot provide those properties.
- Keep the child prompt self-contained: outcome, inputs, owned and read-only scope, acceptance evidence, and the sources the child must read.
- Every child gets an explicit role. A child without a role has no instructions and no accounting.
- Do not create children merely to add process.

## Evidence

- A child self-report is evidence, not independent proof. Reconcile it against the actual diff, output or artifacts.
- If a required capability is unavailable, report that delegation is unavailable and follow the stated fallback; do not substitute an in-process agent when durable lineage is required.

## Plans and consultants

- There is one boss, the lead. When a card needs a plan, a letter to the planner starts the plan chain.
- Architects are consultants called for one question; they answer and finish. The human alone accepts a plan.
