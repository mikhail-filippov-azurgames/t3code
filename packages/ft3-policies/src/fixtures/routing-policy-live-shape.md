---
status: draft
revision: 7
---

# Model selection

The server picks the model. This prose and every other paragraph are ignored by the parser.

## 1. Cells: role × level

Candidates are checked in order; the first available model runs.

| Role                       | low           | medium        | high            | very-high     |
| -------------------------- | ------------- | ------------- | --------------- | ------------- |
| `architect`, `architect-*` | A1 → A2 → A3  | A1 → A2 > A3  | A1@high → A2    | A2 → A3       |
| `implementation`           | I1 → I2       | I2 → I1       | I1 → I2 → IH    | IH → I1       |
| `review-*`                 | R1 → R2       | R1 → R2       | R2 → R1         | R2 → R3       |
| `test`                     | I1 → I2       | I2 → I1       | I1 → I2         | IH → I1       |
| `research`                 | R1 → R2       | R1 → R2       | R2 → R1         | R2 → R3       |
| `general`                  | R1 → R2       | R1 → R2       | R2 → R1 → P@low | R2 → R3       |
| `planner`                  | P@low → Q@low | P@low → Q@low | P@low → Q@low   | P@low → Q@low |

`alias@level` fixes the model level for that candidate. This table is not a policy table:

| note     | value |
| -------- | ----- |
| anything | goes  |

## 2. Targets

### Provider one (`alpha / acp`)

| Alias | model               | low             | medium        | high            | very-high     |
| ----- | ------------------- | --------------- | ------------- | --------------- | ------------- |
| A1    | `alpha-model-one`   | `effort=low`    | `effort=low`  | `effort=medium` | `effort=high` |
| A2    | `alpha-model-two`   | `effort=medium` | `effort=high` | `effort=high`   | `effort=high` |
| A3    | `alpha-model-three` | —               | —             | —               | —             |

### Provider two (`beta / codex`)

| Alias | model                                    | low                                    | medium                   | high                   | very-high               |
| ----- | ---------------------------------------- | -------------------------------------- | ------------------------ | ---------------------- | ----------------------- |
| I1    | `beta-model-one` (Preview)               | `reasoningEffort=low`                  | `reasoningEffort=medium` | `reasoningEffort=high` | `reasoningEffort=xhigh` |
| I2    | `beta-model-two`                         | `reasoningEffort=medium, stream=false` | `reasoningEffort=high`   | `reasoningEffort=high` | `reasoningEffort=high`  |
| IH    | `beta-model-two-highspeed` (double cost) | `reasoningEffort=high`                 | `reasoningEffort=high`   | `reasoningEffort=high` | `reasoningEffort=high`  |

### Provider three (`gamma / agent`)

| Alias | model                  | low            | medium           | high            | very-high      |
| ----- | ---------------------- | -------------- | ---------------- | --------------- | -------------- |
| R1    | `gamma-model-one`      | `variant=low`  | `variant=medium` | `variant=high`  | `variant=high` |
| R2    | `gamma-model-two`      | `variant=low`  | `variant=high`   | `variant=max`   | `variant=max`  |
| R3    | `gamma-model-three`    | `variant=none` | `variant=none`   | `variant=none`  | `variant=none` |
| P     | `gamma-model-pro`      | `thinking=low` | `thinking=low`   | `thinking=high` | `thinking=max` |
| Q     | `gamma-model-pro-lite` | `thinking=low` | `thinking=low`   | `thinking=high` | `thinking=max` |

Trailing prose with a table that is not a policy table:

| column | other |
| ------ | ----- |
| x      | y     |
