# Model Router: All Models + Per-Task Selection - Design

Date: 2026-09-17
Status: Approved

## Problem

The router surfaced only a couple of models and gave no way to choose a
specific model per purpose:

1. Models without a scorecard entry were excluded because `allowUnscored`
   defaulted to `false`. A user with 24 provider models and 3 scorecard entries
   saw exactly 3 eligible models, and tasks could have zero (e.g. `writing`).
2. The only routing lever was `tags`, which restricts the automatic pool; it
   cannot assign a chosen model to a task.

## Goal

- Every model on a configured provider is eligible by default.
- A task can be pinned to a specific model, overriding scoring and tags.
- The settings editor exposes both: a per-task model picker on Routing and the
  full catalog of available models on Models.

## Plugin Changes

- `allowUnscored` default flips to `true`. Unscored models score neutral
  5/5/5. Setting it to `false` restores the previous strict behavior.
- New `taskModels: Record<TaskName, "providerID/modelID">` option:
  - `parseOptions` validates task names and model keys.
  - `rankModels` gains `opts.pinned`. A pinned candidate is ranked first and
    bypasses tag filtering and unscored exclusion. A disabled provider or an
    `excludeModels` entry still excludes it, and the pin is then ignored.
  - `assignAgents` and both tools pass `options.taskModels[task]`.
- New `excludeModels: string[]` lists models the router must skip. Candidates
  carry a `hidden` flag and `rankModels` excludes hidden candidates before pin
  handling.
- The existing `models` scorecard still refines non-pinned ranking.

## Settings Editor Changes

- Payload mirrors the plugin: `taskModels` and `excludeModels` on the form,
  default `allowUnscored: true`, validation for both key lists. Empty lists are
  omitted from the serialized payload.
- The router catalog reads Manage Models visibility (`useModels().visible`), so
  hidden models do not appear in the task select, the bulk picker, or the
  "Available models" section. Already-scored hidden models stay visible with an
  explanation.
- On Save the editor snapshots hidden in-scope models into `excludeModels`,
  because Manage Models visibility is client-side and the server plugin cannot
  read it. Hiding a model later requires another Save.
- Routing tab: each task card gains a "Model for …" select listing available
  models plus an "Automatic (best match)" option.
- Models tab: an "Available models" section lists every in-scope model not yet
  scored, one click from adding it at neutral scores.

## Verification

- Plugin tests cover the new default, `taskModels` and `excludeModels` parsing,
  pin precedence (beats higher score, overrides tags and unscored exclusion,
  ignored when the provider is disabled or the model is hidden), hidden
  candidate marking, and config-hook assignment.
- App payload and preview tests mirror the plugin contract, including a
  cross-package contract test that compares preview output with the real plugin
  for hidden, pinned, tagged, and unscored candidates.
- `bun typecheck` in `packages/opencode`; app unit tests, app typecheck, and
  e2e typecheck.

## Out of Scope

- Live re-routing without restart.
- Automatic price or benchmark discovery.
- Changes to scoring weights or tie-break order.
