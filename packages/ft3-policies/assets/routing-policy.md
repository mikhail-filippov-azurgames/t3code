---
revision: 1
---

# Routing policy

The server picks the model. The lead names a role and a task level; the tables below decide
which model runs.

## Cells: role × level

A cell lists candidates in fallback order, separated by `→` (or `>`). `alias` uses the
options of the task-level column; `alias@level` always uses the options of the named level.
An empty cell or `—` means the role has no candidate for that level.

| Role                       | low | medium | high | very-high |
| -------------------------- | --- | ------ | ---- | --------- |
| `architect`, `architect-*` |     |        |      |           |
| `implementation`           |     |        |      |           |
| `review-*`                 |     |        |      |           |
| `test`                     |     |        |      |           |
| `research`                 |     |        |      |           |
| `general`                  |     |        |      |           |
| `planner`                  |     |        |      |           |

`lead` is not routed here: the human starts the thread with the model he chooses.

## Aliases

Every alias table belongs to the heading right above it, which ends in
(`<providerInstanceId> / <driverKind>`). The alias column is unique across the document;
the model id is written in backticks and any text after it is ignored; each level column
holds `—` or comma-separated `key=value` options.

### Example provider (`provider / driver`)

| Alias | model | low | medium | high | very-high |
| ----- | ----- | --- | ------ | ---- | --------- |
