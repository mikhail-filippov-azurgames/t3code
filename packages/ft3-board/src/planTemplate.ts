// The bundled server does not ship assets/; planTemplate.test.ts keeps this copy identical to it.
export const PLAN_TEMPLATE = `---
schema: corvis-plan-v1
cardId: <cardId>
---

# Plan: <card title>

## Goal

## Decisions

## Steps

| step | change | owns | verify |
| ---- | ------ | ---- | ------ |

## Risks and rollback
`;
