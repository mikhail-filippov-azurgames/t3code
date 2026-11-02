---
name: create-orchestrator-architect
description: Retired. The Coordinator-Architect binding flow is no longer current; architects are consultants called for one question via delegate_task, and the planner role writes plans. Do not create or bind an Architect.
---

# Create Orchestrator Architect (retired)

This skill is retired. There is exactly one boss, the lead. Architects (`architect`,
`architect-*`) are consultants the lead may call for one concrete question through
`delegate_task`; they are not bound to the lead and own no board cards. For a card that
needs a plan, the lead asks the `planner` role and follows its role file.

`architect_create_or_get`, `get_lead_binding` and the review tools remain only for
existing bindings and their data. Do not call them for new work.
