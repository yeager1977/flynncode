# Model Router: Coding Policy and Value Lane - Design

Date: 2026-09-18
Status: Approved

## Problem

The router treats `coding` as cost-balanced, so it routes to GLM-5.3-Flash or
DeepSeek V4.1 Flash and can never pick Claude Opus 5, the strongest coding
model. `review` was pinned to Claude Sonnet 5, which is both weaker and more
expensive than alternatives. There is no single-selection way to ask for a
cheap routed lane without giving up routing.

## Evidence (Artificial Analysis, 2026-09-18)

Intelligence Index, cost per task, and blended price (3x input + output / 4,
USD per million tokens) for the models in scope:

| Model | AA Index | $/task | blend $/M |
|---|---|---|---|
| Claude Fable 5.1 | 53 | 7.63 | 20.0 |
| GPT-6 Astra | 53 | 3.26 | 20.0 |
| Claude Opus 5 | 51 | 5.86 | 10.0 |
| GPT-5.6 Sol | 47 | 1.99 | 8.0 |
| GLM-5.3 | 45 | 2.01 | 2.15 |
| Kimi K3 | 44 | 2.00 | 6.0 |
| GPT-5.6 Terra | 42 | 1.40 | 4.5 |
| GLM-5.3-Flash | 42 | 0.25 | 0.24 |
| DeepSeek V4.1 Flash | 40 | 0.27 | 0.26 |
| Claude Sonnet 5 | 38 | 5.09 | 4.0 |
| GPT-5.6 Luna | 38 | 0.18 | 0.45 |

This confirms the user's read: Opus 5 is the coding flagship, and DeepSeek
V4.1 Flash / GLM-5.3-Flash sit just behind it at roughly 20x lower cost. It
also shows the previous `review` pin (Sonnet 5) was dominated.

## Decision

- `coding` defaults to **Claude Opus 5** by making coded task weights
  capability-dominant. Cheap Flash coding remains one selection away.
- `review` is pinned to **GLM-5.3**.
- Every task gains a cost-dominant `-value` variant for a cheap routed lane.
- Override remains available three ways: pick a concrete model, select a
  `-value` variant, or pin/edit in settings.

## Routing Changes

### Coding weights

`coding` moves from `0.60 / 0.25 / 0.15` to `0.70 / 0.10 / 0.20` (capability /
price / speed). With Fable 5.1 and Astra reserved by task tags, the coding pool
scores: Opus 5 (8.00), GPT-5.6 Sol (7.50), GLM-5.3-Flash (7.50), DeepSeek V4.1
Flash (7.50). Opus 5 wins; the Flash models are the immediate fallbacks.

### Review pin

`taskModels.review` changes from `anthropic/claude-sonnet-5` to
`ollama-cloud/glm-5.3` (AA 45 at 2.15 blend versus AA 38 at 4.0).

### Value lane

A built-in value profile of `0.25 / 0.65 / 0.10` is applied when the selected
variant ends in `-value`. The router advertises one variant per task plus one
`<task>-value` variant per task.

- `coding-value` resolves to GLM-5.3-Flash / DeepSeek V4.1 Flash.
- A `-value` variant **ignores the task pin**, so `review-value` does not
  collapse back to pinned GLM-5.3 and stays genuinely cheap.
- An unknown or absent variant falls back to the agent-mapped task with normal
  weights and pin, as today.

### Scorecard corrections

Card capability and price are resynced to the table above: Opus 5 cap 10 /
price 8, Fable 5.1 cap 10 / price 9, Astra cap 10 / price 9, Sol cap 9 /
price 8, GLM-5.3 cap 8 / price 4, Kimi K3 cap 8 / price 7, Terra cap 7 /
price 7, GLM-5.3-Flash cap 7 / price 2, DeepSeek V4.1 Flash cap 7 / price 2,
Sonnet 5 cap 6 / price 5, Luna cap 6 / price 3. Speed estimates are unchanged
except where the table's per-task cost implies a different lane.

## Implementation Map

- `packages/opencode/src/plugin/ollama-model-router/scorecard.ts`: add
  `VALUE_TASK_WEIGHTS` and a `parseTaskVariant(variant)` helper returning the
  base task and whether it is a value variant.
- `packages/opencode/src/plugin/ollama-model-router/index.ts`: build
  `ROUTER_VARIANTS` from tasks plus `-value` siblings; in the sentinel
  resolver, select value weights and drop the pin for value variants.
- `packages/opencode/src/plugin/ollama-model-router/assign.ts`: allow a weights
  override and an explicit pin suppression in task resolution.
- Config `opencode.jsonc`: the coding weights, review pin, and resynced cards.

No app UI change is required: the composer variant selector already lists a
model's variants, and the settings editor already edits weights and pins.

## Verification

- Plugin tests: `parseTaskVariant`, value-variant ranking uses value weights,
  value variant ignores the pin, unknown variant falls back, and the coding
  winner is Opus 5 under the new weights.
- Existing plugin and app suites stay green; typechecks pass.
- Live `rank_models` smoke check shows Opus 5 winning `coding` and a Flash model
  winning the cheap lane.

## Out of Scope

- New UI controls for the value lane.
- Auto-escalation based on prompt difficulty.
- Network price or benchmark fetching at runtime.
